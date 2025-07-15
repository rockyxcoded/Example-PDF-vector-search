import fs from 'fs';
import pdf from 'pdf-parse';
import pkg from 'pg';
import OpenAI from 'openai';
import dotenv from 'dotenv';

const { Pool, Client } = pkg;
dotenv.config();

export default class PDFRagSDK {
  constructor(usePool = true) {
    this.usePool = usePool;

    const dbConfig = {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT || 5432,
    };

    if (usePool) {
      this.db = new Pool(dbConfig);
    } else {
      this.db = new Client(dbConfig);
    }

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.embeddingModel = 'text-embedding-ada-002';
    this.chatModel = 'gpt-3.5-turbo';
    this.chunkSize = 800;
  }

  chunkText(text, maxChunkSize = this.chunkSize) {
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = '';

    for (const para of paragraphs) {
      if ((currentChunk + para).length <= maxChunkSize * 4) { 
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        if (para.length <= maxChunkSize * 4) {
          currentChunk = para;
        } else {
          // Paragraph too big, split by sentence
          const sentences = para.match(/[^\.!\?]+[\.!\?]+/g) || [para];
          for (const sentence of sentences) {
            if ((currentChunk + sentence).length <= maxChunkSize * 4) {
              currentChunk += (currentChunk ? ' ' : '') + sentence;
            } else {
              if (currentChunk) chunks.push(currentChunk);
              currentChunk = sentence;
            }
          }
        }
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    return chunks;
  }

  async retryWithBackoff(fn, retries = 3, delay = 1000) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === retries - 1) throw err;
        const waitTime = delay * 2 ** attempt;
        console.warn(`Retry attempt ${attempt + 1} after error: ${err.message}. Waiting ${waitTime}ms...`);
        await new Promise(res => setTimeout(res, waitTime));
      }
    }
  }

  async init() {
    try {
      if (!this.usePool) await this.db.connect();

      await this.db.query('CREATE EXTENSION IF NOT EXISTS vector;');

      await this.db.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          embedding vector(1536),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await this.db.query(`
        CREATE INDEX IF NOT EXISTS documents_embedding_idx 
        ON documents USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
      `);

      console.log('Database initialized');
    } catch (error) {
      console.error(' Database init error:', error);
      throw error;
    }
  }

  async generateEmbedding(text) {
    return await this.retryWithBackoff(async () => {
      const response = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: text,
      });
      return response.data[0].embedding;
    });
  }

  async addDocument(filePath) {
    try {
      const buffer = fs.readFileSync(filePath);
      const data = await pdf(buffer);
      const textContent = data.text;

      if (!textContent.trim()) {
        throw new Error('No text content found in PDF');
      }

      const filename = filePath.split('/').pop();
      const chunks = this.chunkText(textContent);

      const insertedIds = [];
      for (const chunk of chunks) {
        const embedding = await this.generateEmbedding(chunk);

        const query = `
          INSERT INTO documents (filename, content, embedding)
          VALUES ($1, $2, $3)
          RETURNING id;
        `;

        const result = await this.db.query(query, [
  filename,
  chunk,
  `[${embedding.join(',')}]`,
]);
        insertedIds.push(result.rows[0].id);
      }

      console.log(`Document "${filename}" added with ${insertedIds.length} chunks.`);
      return insertedIds;
    } catch (error) {
      console.error(' Add document error:', error);
      throw error;
    }
  }

  async searchSimilar(query, limit = 3) {
    try {
      const queryEmbedding = await this.generateEmbedding(query);

      const searchQuery = `
        SELECT id, filename, content, 
               embedding <=> $1 as similarity
        FROM documents
        ORDER BY embedding <=> $1
        LIMIT $2;
      `;

      const result = await this.db.query(searchQuery, [`[${queryEmbedding.join(',')}]`, limit]);


      return result.rows.map(row => ({
        id: row.id,
        filename: row.filename,
        content: row.content,
        similarity: row.similarity,
      }));
    } catch (error) {
      console.error(' Search error:', error);
      throw error;
    }
  }

  async askAboutDocuments(question, contextLimit = 3) {
    try {
      const relevantDocs = await this.searchSimilar(question, contextLimit);
      // console.log({ relevantDocs });

      if (relevantDocs.length === 0) {
        return {
          answer: "I don't have any relevant documents to answer your question.",
          sourceDocuments: [],
        };
      }

      const context = relevantDocs
        .map(doc => `Document: ${doc.filename}\nContent: ${doc.content.substring(0, 1000)}...`)
        .join('\n\n');

      const response = await this.retryWithBackoff(async () => {
        return await this.openai.chat.completions.create({
          model: this.chatModel,
          messages: [
            {
              role: 'system',
              content:
                'You are a helpful assistant. Answer the user\'s question based on the provided document context. If the answer is not in the context, say so.',
            },
            {
              role: 'user',
              content: `Context:\n${context}\n\nQuestion: ${question}`,
            },
          ],
          max_tokens: 500,
          temperature: 0.7,
        });
      });

      return {
        answer: response.choices[0].message.content,
        sourceDocuments: relevantDocs.map(doc => ({
          filename: doc.filename,
          similarity: doc.similarity,
        })),
      };
    } catch (error) {
      console.error(' Ask error:', error);
      throw error;
    }
  }

  async listDocuments() {
    try {
      const query = `
        SELECT filename, MAX(created_at) as created_at,
          (SELECT LEFT(content, 200) FROM documents d2 WHERE d2.filename = d1.filename LIMIT 1) AS preview
        FROM documents d1
        GROUP BY filename
        ORDER BY created_at DESC;
      `;

      const result = await this.db.query(query);
      return result.rows;
    } catch (error) {
      console.error(' List documents error:', error);
      throw error;
    }
  }

  async deleteDocumentByFilename(filename) {
    try {
      const query = 'DELETE FROM documents WHERE filename = $1 RETURNING id';
      const result = await this.db.query(query, [filename]);

      if (result.rowCount === 0) {
        throw new Error('Document not found');
      }

      console.log(`Deleted document "${filename}" with ${result.rowCount} chunks.`);
      return filename;
    } catch (error) {
      console.error('Delete error:', error);
      throw error;
    }
  }

  async close() {
    await this.db.end();
    console.log('Database connection closed');
  }
}