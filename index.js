const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const app = express();
const PORT = 3000;

const uploadDir = path.join(__dirname, 'uploads');
const tempCompressedDir = path.join(__dirname, 'temp_compressed');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(tempCompressedDir)) fs.mkdirSync(tempCompressedDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));

const compressionProgress = {};
const batchWorkers = new Map();

// Cleanup function to remove files from a directory
function cleanupDirectory(directory) {
    try {
        const files = fs.readdirSync(directory);
        files.forEach(file => {
            const filePath = path.join(directory, file);
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                console.error(`Failed to delete ${filePath}:`, err);
            }
        });
        console.log(`Cleaned up directory: ${directory}`);
    } catch (err) {
        console.error(`Failed to read directory ${directory}:`, err);
    }
}

// Cleanup specific batch files
function cleanupBatchFiles(batchId) {
    // This will be called from the worker or on error
    console.log(`Cleaning up batch ${batchId}`);
}

// Cleanup stale files on server start
function cleanupOnStart() {
    console.log('Performing startup cleanup...');
    cleanupDirectory(uploadDir);
    cleanupDirectory(tempCompressedDir);
}

// Periodic cleanup of old files (runs every 30 minutes)
function startPeriodicCleanup() {
    setInterval(() => {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutes

        // Clean uploads directory
        try {
            const uploadFiles = fs.readdirSync(uploadDir);
            uploadFiles.forEach(file => {
                const filePath = path.join(uploadDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted old upload file: ${file}`);
                }
            });
        } catch (err) {
            console.error('Error during periodic cleanup of uploads:', err);
        }

        // Clean temp_compressed directory
        try {
            const tempFiles = fs.readdirSync(tempCompressedDir);
            tempFiles.forEach(file => {
                const filePath = path.join(tempCompressedDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted old compressed file: ${file}`);
                }
            });
        } catch (err) {
            console.error('Error during periodic cleanup of temp_compressed:', err);
        }
    }, 30 * 60 * 1000); // Run every 30 minutes
}

app.post('/compress', upload.array('images'), async (req, res) => {
    const { maxWidth, maxHeight, quality, zipFolderName } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).send('No files uploaded.');
    }

    // Generate unique batch ID with timestamp and random component
    const batchId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    compressionProgress[batchId] = {
        total: files.length,
        completed: 0,
        status: 'Processing',
        files: files.map(f => f.originalname)
    };

    const settings = {
        maxWidth: parseInt(maxWidth) || 1280,
        maxHeight: parseInt(maxHeight) || 1280,
        quality: parseInt(quality) || 80
    };

    console.log(`Starting batch ${batchId} with ${files.length} images.`);

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

    batchWorkers.set(batchId, worker);

    worker.on('message', (msg) => {
        if (msg.type === 'progress') {
            compressionProgress[batchId].completed = msg.completed;
        } else if (msg.type === 'complete') {
            compressionProgress[batchId].status = 'Complete';
            compressionProgress[batchId].zipName = msg.zipName;
            console.log(`Batch ${batchId} completed. Zip file: ${msg.zipPath}`);
            batchWorkers.delete(batchId);
        } else if (msg.type === 'error') {
            compressionProgress[batchId].status = 'Error';
            console.error(`Worker error for batch ${batchId}:`, msg.error);
            
            // Cleanup files on error
            cleanupBatchUploadedFiles(batchId);
            batchWorkers.delete(batchId);
        }
    });

    worker.on('error', (err) => {
        compressionProgress[batchId].status = 'Error';
        console.error(`Worker thread error for batch ${batchId}:`, err);
        
        // Cleanup files on error
        cleanupBatchUploadedFiles(batchId);
        batchWorkers.delete(batchId);
    });

    worker.on('exit', (code) => {
        if (code !== 0 && compressionProgress[batchId] && compressionProgress[batchId].status !== 'Error') {
            compressionProgress[batchId].status = 'Failed';
            console.error(`Worker stopped with exit code ${code} for batch ${batchId}`);
            
            // Cleanup files on failure
            cleanupBatchUploadedFiles(batchId);
        }
        batchWorkers.delete(batchId);
    });

    res.json({ batchId });
});

// Helper function to cleanup uploaded files for a specific batch
function cleanupBatchUploadedFiles(batchId) {
    const batchData = compressionProgress[batchId];
    if (!batchData || !batchData.files) return;

    batchData.files.forEach(filename => {
        const filePath = path.join(uploadDir, filename);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up uploaded file: ${filename}`);
            }
        } catch (err) {
            console.error(`Failed to cleanup ${filename}:`, err);
        }
    });
}

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

app.get('/download/:batchId', (req, res) => {
    const { batchId } = req.params;
    const progressData = compressionProgress[batchId];

    if (!progressData || progressData.status !== 'Complete' || !progressData.zipName) {
        return res.status(404).send('Zip file not found or compression not complete.');
    }

    const finalZipName = progressData.zipName;
    const zipPath = path.join(tempCompressedDir, finalZipName);

    if (!fs.existsSync(zipPath)) {
        return res.status(404).send('Zip file not found on server disk.');
    }

    res.download(zipPath, finalZipName, (err) => {
        if (err) {
            console.error('Download error:', err);
        }

        delete compressionProgress[batchId];
        try {
            fs.unlinkSync(zipPath);
            console.log(`Deleted zip file after download: ${finalZipName}`);
        } catch (e) {
            console.error('Cleanup failed:', e);
        }
    });
});

// Endpoint to cleanup abandoned batches (called from client on page unload)
app.post('/cleanup/:batchId', (req, res) => {
    const { batchId } = req.params;
    const progressData = compressionProgress[batchId];

    if (!progressData) {
        return res.status(404).send('Batch ID not found.');
    }

    // Terminate worker if still running
    const worker = batchWorkers.get(batchId);
    if (worker) {
        worker.terminate();
        batchWorkers.delete(batchId);
        console.log(`Terminated worker for batch ${batchId}`);
    }

    // Cleanup uploaded files
    cleanupBatchUploadedFiles(batchId);

    // Cleanup zip file if exists
    if (progressData.zipName) {
        const zipPath = path.join(tempCompressedDir, progressData.zipName);
        try {
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
                console.log(`Cleaned up zip file: ${progressData.zipName}`);
            }
        } catch (err) {
            console.error(`Failed to cleanup zip file:`, err);
        }
    }

    delete compressionProgress[batchId];
    res.json({ success: true });
});

// Cleanup on server start
cleanupOnStart();

// Start periodic cleanup
startPeriodicCleanup();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Server shutting down...');
    
    // Terminate all active workers
    batchWorkers.forEach((worker, batchId) => {
        console.log(`Terminating worker for batch ${batchId}`);
        worker.terminate();
    });
    
    // Cleanup all directories
    cleanupDirectory(uploadDir);
    cleanupDirectory(tempCompressedDir);
    
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Server shutting down...');
    
    // Terminate all active workers
    batchWorkers.forEach((worker, batchId) => {
        console.log(`Terminating worker for batch ${batchId}`);
        worker.terminate();
    });
    
    // Cleanup all directories
    cleanupDirectory(uploadDir);
    cleanupDirectory(tempCompressedDir);
    
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});