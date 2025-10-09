// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const app = express();
const PORT = 3000;

// --- Configuration ---
// Temporary storage for uploaded files and compressed results
const uploadDir = path.join(__dirname, 'uploads');
const tempCompressedDir = path.join(__dirname, 'temp_compressed');
// Ensure directories exist
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(tempCompressedDir)) fs.mkdirSync(tempCompressedDir);

// Multer storage configuration for handling file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Use original name for now, will rename in compression
        cb(null, file.originalname); 
    }
});
const upload = multer({ storage: storage });

app.use(express.json()); // To parse JSON bodies
app.use(express.static('public')); // Serve the front-end (index.html, etc.)

// Global map to track progress for multiple batches/users
const compressionProgress = {};

// --- API Endpoint: Batch Compression ---
app.post('/compress', upload.array('images'), async (req, res) => {
    // 1. Get user settings and uploaded files
    const { maxWidth, maxHeight, quality, zipFolderName } = req.body;
    const files = req.files; // Array of file objects from multer

    if (!files || files.length === 0) {
        return res.status(400).send('No files uploaded.');
    }

    const batchId = Date.now().toString();
    compressionProgress[batchId] = { total: files.length, completed: 0, status: 'Processing' };

    // Default settings (matching the screenshot defaults)
    const settings = {
        maxWidth: parseInt(maxWidth) || 1280,
        maxHeight: parseInt(maxHeight) || 1280,
        quality: parseInt(quality) || 80
    };

    console.log(`Starting batch ${batchId} with ${files.length} images.`);

    // 2. Delegate to Worker Thread for Processing & Zipping
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: {
            files,
            settings,
            uploadDir,
            tempCompressedDir,
            batchId,
            zipFolderName
        }
    });

    // Handle messages from the worker
    worker.on('message', (msg) => {
        if (msg.type === 'progress') {
            compressionProgress[batchId].completed = msg.completed;
        } else if (msg.type === 'complete') {
            compressionProgress[batchId].status = 'Complete';
            compressionProgress[batchId].zipName = msg.zipName;
            // The worker will save the zip, now we can inform the user via a separate endpoint
            console.log(`Batch ${batchId} completed. Zip file: ${msg.zipPath}`);
        } else if (msg.type === 'error') {
            compressionProgress[batchId].status = 'Error';
            console.error(`Worker error for batch ${batchId}:`, msg.error);
        }
    });

    worker.on('error', (err) => {
        compressionProgress[batchId].status = 'Error';
        console.error(`Worker thread error for batch ${batchId}:`, err);
    });

    worker.on('exit', (code) => {
        if (code !== 0 && compressionProgress[batchId].status !== 'Error') {
            compressionProgress[batchId].status = 'Failed';
            console.error(`Worker stopped with exit code ${code} for batch ${batchId}`);
        }
    });

    // 3. Respond immediately to the client with the batch ID
    // The client will use this ID to poll the progress and download the final zip.
    res.json({ batchId: batchId });
});

// --- API Endpoint: Progress and Download ---

// Get the current progress percentage
app.get('/progress/:batchId', (req, res) => {
    const { batchId } = req.params;
    const progressData = compressionProgress[batchId];

    if (!progressData) {
        return res.status(404).send('Batch ID not found.');
    }

    const progressPercent = Math.round((progressData.completed / progressData.total) * 100);

    res.json({
        progress: progressPercent,
        status: progressData.status,
        totalFiles: progressData.total,
        completedFiles: progressData.completed
    });
});

// Download the final zip file
app.get('/download/:batchId', (req, res) => {
    const { batchId } = req.params;
    const progressData = compressionProgress[batchId];

    if (!progressData || progressData.status !== 'Complete' || !progressData.zipName) {
         return res.status(404).send('Zip file not found or compression not complete.');
    }
    
    // Use the name determined by the worker
    const finalZipName = progressData.zipName; 
    const zipPath = path.join(tempCompressedDir, finalZipName);

    if (!fs.existsSync(zipPath)) {
        return res.status(404).send('Zip file not found on server disk.');
    }

    // Send the file using the original folder name for the download
    res.download(zipPath, finalZipName, (err) => { // <-- USE finalZipName for the client
        if (err) {
            console.error('Download error:', err);
        }
        
        // Cleanup:
        delete compressionProgress[batchId]; 
        try {
             fs.unlinkSync(zipPath); 
        } catch (e) {
             console.error('Cleanup failed:', e);
        }
    });
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
