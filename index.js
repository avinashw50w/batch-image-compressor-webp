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

app.post('/compress', upload.array('images'), async (req, res) => {
    const { maxWidth, maxHeight, quality, zipFolderName } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).send('No files uploaded.');
    }

    const batchId = Date.now().toString();
    compressionProgress[batchId] = {
        total: files.length,
        completed: 0,
        status: 'Processing'
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

    worker.on('message', (msg) => {
        if (msg.type === 'progress') {
            compressionProgress[batchId].completed = msg.completed;
        } else if (msg.type === 'complete') {
            compressionProgress[batchId].status = 'Complete';
            compressionProgress[batchId].zipName = msg.zipName;
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

    res.json({ batchId });
});

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
        } catch (e) {
            console.error('Cleanup failed:', e);
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});