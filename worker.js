// worker.js
const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const fs = require('fs/promises'); 
const path = require('path');
const archiver = require('archiver');
const fsSync = require('fs');

async function compressAndZip() {
    const { files, settings, uploadDir, tempCompressedDir, batchId, zipFolderName } = workerData; // <-- DESTRUCTURE NEW VARIABLE
    let completedCount = 0;
    const archive = archiver('zip', { zlib: { level: 9 } });

    try {
        // 1. Determine the output zip file name
        let zipName = zipFolderName 
            ? `${zipFolderName}.zip` // Use uploaded folder name
            : `compressed_images_${batchId}.zip`; // Use default name

        const zipPath = path.join(tempCompressedDir, zipName);
        const output = fsSync.createWriteStream(zipPath);
        
        archive.pipe(output);

        // 2. Process each file (Image compression logic remains the same)
        for (const file of files) {
            const originalPath = path.join(uploadDir, file.originalname);
            const fileNameWithoutExt = path.parse(file.originalname).name;
            const outputFileName = `${fileNameWithoutExt}.webp`;

            // ... (Compression logic using sharp remains here) ...
            await sharp(originalPath)
                .resize({
                    width: settings.maxWidth,
                    height: settings.maxHeight,
                    fit: 'inside', 
                    withoutEnlargement: true 
                })
                .webp({ quality: settings.quality, alphaQuality: 100 })
                .toBuffer()
                .then(compressedBuffer => {
                    archive.append(compressedBuffer, { name: outputFileName });
                })
                .catch(err => {
                    console.error(`Error compressing ${file.originalname}:`, err);
                });

            completedCount++;
            parentPort.postMessage({ type: 'progress', completed: completedCount });
            await fs.unlink(originalPath).catch(console.error);
        }

        // 3. Finalize the zip archive
        await archive.finalize();

        output.on('close', () => {
            parentPort.postMessage({ type: 'complete', zipPath: zipPath, zipName: zipName }); // <-- PASS zipName
        });

        archive.on('error', (err) => {
            throw err;
        });

    } catch (error) {
        parentPort.postMessage({ type: 'error', error: error.message });
    }
}

compressAndZip();