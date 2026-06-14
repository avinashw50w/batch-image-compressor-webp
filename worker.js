const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const archiver = require('archiver');
const fsSync = require('fs');

const CONCURRENCY = 6; // process N images in parallel

function shouldCompress(fileName) {
	const ext = path.extname(fileName).toLowerCase();
	return ['.jpg', '.jpeg', '.png'].includes(ext);
}

async function processFile(file, settings, uploadDir) {
    const originalPath = path.join(uploadDir, file.filename); // filename = batchId-prefixed on-disk name
    const fileNameWithoutExt = path.parse(file.originalname).name; // originalname = clean name for zip entry

    if (shouldCompress(file.originalname)) {
    	const outputFileName = `${fileNameWithoutExt}.webp`;
    	try {
    		const compressedBuffer = await sharp(originalPath)
    		.resize({
    			width: settings.maxWidth,
    			height: settings.maxHeight,
    			fit: 'inside',
    			withoutEnlargement: true
    		})
    		.webp({ quality: settings.quality, alphaQuality: 100 })
    		.toBuffer();
    		return { name: outputFileName, buffer: compressedBuffer, originalPath };
    	} catch (err) {
    		console.warn(`Sharp failed for ${file.originalname}, including as-is:`, err.message);
    		const fileBuffer = await fs.readFile(originalPath);
    		return { name: file.originalname, buffer: fileBuffer, originalPath };
    	}
    } else {
    	const fileBuffer = await fs.readFile(originalPath);
    	return { name: file.originalname, buffer: fileBuffer, originalPath };
    }
}

async function compressAndZip() {
	const { files, settings, uploadDir, tempCompressedDir, batchId, zipFolderName } = workerData;
	let completedCount = 0;

	try {
		const zipName = zipFolderName
		? `${zipFolderName}.zip`
		: `compressed_images_${batchId}.zip`;

		const zipPath = path.join(tempCompressedDir, zipName);
		const output = fsSync.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 6 } }); // level 6 is sweet spot; 9 is slow with little gain

        archive.pipe(output);

        // Process in parallel batches of CONCURRENCY
        for (let i = 0; i < files.length; i += CONCURRENCY) {
        	const chunk = files.slice(i, i + CONCURRENCY);
        	const results = await Promise.all(
        		chunk.map(file => processFile(file, settings, uploadDir))
        		);

        	for (const result of results) {
        		archive.append(result.buffer, { name: result.name });
        		await fs.unlink(result.originalPath).catch(console.error);
        		completedCount++;
        		parentPort.postMessage({ type: 'progress', completed: completedCount });
        	}
        }

        await archive.finalize();

        output.on('close', () => {
        	parentPort.postMessage({ type: 'complete', zipPath, zipName });
        });

        archive.on('error', (err) => {
        	throw err;
        });
    } catch (error) {
    	parentPort.postMessage({ type: 'error', error: error.message });
    }
}

compressAndZip();