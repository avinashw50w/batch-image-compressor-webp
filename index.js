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
	filename: (req, file, cb) => {
        // Prefix with batchId so concurrent uploads don't collide on same filename
		const batchId = req._batchId;
		cb(null, `${batchId}_${file.originalname}`);
	}
});

const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));

const compressionProgress = {};
const batchWorkers = new Map();

function cleanupDirectory(directory) {
	try {
		const files = fs.readdirSync(directory);
		files.forEach(file => {
			const filePath = path.join(directory, file);
			try { fs.unlinkSync(filePath); } catch (err) { console.error(`Failed to delete ${filePath}:`, err); }
		});
		console.log(`Cleaned up directory: ${directory}`);
	} catch (err) {
		console.error(`Failed to read directory ${directory}:`, err);
	}
}

function cleanupOnStart() {
	console.log('Performing startup cleanup...');
	cleanupDirectory(uploadDir);
	cleanupDirectory(tempCompressedDir);
}

function startPeriodicCleanup() {
	setInterval(() => {
		const now = Date.now();
		const maxAge = 30 * 60 * 1000;
		for (const dir of [uploadDir, tempCompressedDir]) {
			try {
				fs.readdirSync(dir).forEach(file => {
					const filePath = path.join(dir, file);
					if (now - fs.statSync(filePath).mtimeMs > maxAge) {
						fs.unlinkSync(filePath);
						console.log(`Deleted stale file: ${file}`);
					}
				});
			} catch (err) {
				console.error('Periodic cleanup error:', err);
			}
		}
	}, 30 * 60 * 1000);
}

// Attach a batchId to the request before multer runs so filenames are unique
function attachBatchId(req, res, next) {
	req._batchId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	next();
}

app.post('/compress', attachBatchId, upload.array('images'), async (req, res) => {
	const { maxWidth, maxHeight, quality, zipFolderName } = req.body;
	const files = req.files;
	const batchId = req._batchId;

	if (!files || files.length === 0) {
		return res.status(400).send('No files uploaded.');
	}

	compressionProgress[batchId] = {
		total: files.length,
		completed: 0,
		status: 'Processing',
        files: files.map(f => f.filename) // store actual on-disk names
    };

    const settings = {
    	maxWidth: parseInt(maxWidth) || 1280,
    	maxHeight: parseInt(maxHeight) || 1280,
    	quality: parseInt(quality) || 80
    };

    // Respond immediately — client gets batchId and can show UI right away
    res.json({ batchId });

    console.log(`Starting batch ${batchId} with ${files.length} images.`);

    const worker = new Worker(path.join(__dirname, 'worker.js'), {
    	workerData: { files, settings, uploadDir, tempCompressedDir, batchId, zipFolderName }
    });

    batchWorkers.set(batchId, worker);

    worker.on('message', (msg) => {
    	if (msg.type === 'progress') {
    		compressionProgress[batchId].completed = msg.completed;
    	} else if (msg.type === 'complete') {
    		compressionProgress[batchId].status = 'Complete';
    		compressionProgress[batchId].zipName = msg.zipName;
    		console.log(`Batch ${batchId} complete: ${msg.zipPath}`);
    		batchWorkers.delete(batchId);
    	} else if (msg.type === 'error') {
    		compressionProgress[batchId].status = 'Error';
    		console.error(`Worker error for batch ${batchId}:`, msg.error);
    		cleanupBatchUploadedFiles(batchId);
    		batchWorkers.delete(batchId);
    	}
    });

    worker.on('error', (err) => {
    	compressionProgress[batchId].status = 'Error';
    	console.error(`Worker thread error for batch ${batchId}:`, err);
    	cleanupBatchUploadedFiles(batchId);
    	batchWorkers.delete(batchId);
    });

    worker.on('exit', (code) => {
    	if (code !== 0 && compressionProgress[batchId] && compressionProgress[batchId].status !== 'Error') {
    		compressionProgress[batchId].status = 'Failed';
    		console.error(`Worker exited with code ${code} for batch ${batchId}`);
    		cleanupBatchUploadedFiles(batchId);
    	}
    	batchWorkers.delete(batchId);
    });
});

function cleanupBatchUploadedFiles(batchId) {
	const batchData = compressionProgress[batchId];
	if (!batchData?.files) return;
	batchData.files.forEach(filename => {
		const filePath = path.join(uploadDir, filename);
		try {
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
				console.log(`Cleaned up: ${filename}`);
			}
		} catch (err) {
			console.error(`Failed to cleanup ${filename}:`, err);
		}
	});
}

app.get('/progress/:batchId', (req, res) => {
	const progressData = compressionProgress[req.params.batchId];
	if (!progressData) return res.status(404).send('Batch ID not found.');

	res.json({
		progress: Math.round((progressData.completed / progressData.total) * 100),
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

	const zipPath = path.join(tempCompressedDir, progressData.zipName);
	if (!fs.existsSync(zipPath)) return res.status(404).send('Zip file not found on disk.');

	res.download(zipPath, progressData.zipName, (err) => {
		if (err) console.error('Download error:', err);
		setTimeout(() => { delete compressionProgress[batchId]; }, 5000);
		try { fs.unlinkSync(zipPath); } catch (e) { console.error('Cleanup failed:', e); }
	});
});

app.post('/cleanup/:batchId', (req, res) => {
	const { batchId } = req.params;
	const progressData = compressionProgress[batchId];
	if (!progressData) return res.status(404).send('Batch ID not found.');

	const worker = batchWorkers.get(batchId);
	if (worker) {
		worker.terminate();
		batchWorkers.delete(batchId);
	}

	cleanupBatchUploadedFiles(batchId);

	if (progressData.zipName) {
		const zipPath = path.join(tempCompressedDir, progressData.zipName);
		try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (err) { console.error(err); }
	}

	delete compressionProgress[batchId];
	res.json({ success: true });
});

cleanupOnStart();
startPeriodicCleanup();

const shutdown = () => {
	console.log('Shutting down...');
	batchWorkers.forEach((worker, batchId) => { console.log(`Terminating ${batchId}`); worker.terminate(); });
	cleanupDirectory(uploadDir);
	cleanupDirectory(tempCompressedDir);
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));