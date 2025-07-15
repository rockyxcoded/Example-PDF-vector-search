import PDFRagSDK from './pdf-rag-sdk.js';
import fs from 'fs';

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const rag = new PDFRagSDK(true);
  
  try {
    await rag.init();
    
    console.log('Checking for PDF documents...');
    
    const testFiles = ['./doc001.pdf'];
    const addedDocs = [];
    
    for (const file of testFiles) {
      try {
        if (await fileExists(file)) {
          console.log(`Adding ${file}...`);
          const docId = await rag.addDocument(file);
          addedDocs.push(docId);
        }
      } catch (error) {
        console.log(` Skipping ${file}: ${error.message}`);
      }
    }
    
    if (addedDocs.length === 0) {
      console.log('No PDF files found. Add some PDFs to test the functionality.');
      console.log('You can add files like: ./document.pdf, ./research-paper.pdf, etc.');
    }
    
    console.log('\n All documents:');
    const docs = await rag.listDocuments();
    docs.forEach(doc => {
      console.log(`- ${doc.filename} (ID: ${doc.id})`);
      console.log(`  Preview: ${doc.preview}...`);
    });
    
    if (docs.length > 0) {
      console.log('\n Asking AI about documents...');
      
      const question1 = 'What are the main topics covered in these documents?';
      const response1 = await rag.askAboutDocuments(question1);
      console.log(`\nQ: ${question1}`);
      console.log(`A: ${response1.answer}`);
      
      if (response1.sourceDocuments) {
        console.log(`Sources: ${response1.sourceDocuments.map(d => d.filename).join(', ')}`);
      }
      
      const question2 = 'What are the main topics covered in these documents?';
      const response2 = await rag.askAboutDocuments(question2);
      console.log(`\nQ: ${question2}`);
      console.log(`A: ${response2.answer}`);
      
    
      console.log('\n Searching for similar content...');
      const similar = await rag.searchSimilar('machine learning algorithms', 2);
      similar.forEach(doc => {
        console.log(`- ${doc.filename} (similarity: ${doc.similarity.toFixed(4)})`);
      });
    } else {
      console.log('\n To test the AI features, add some PDF files and run again!');
      console.log('Example: Place a PDF file in the current directory and update the file paths.');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await rag.close();
  }
}

main();