// worker.js
const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const fs = require('fs/promises'); 
const path = require('path');
const archiver = require('archiver');
const fsSync = require('fs');

function shouldCompress(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return ext === '.jpg' || ext === '.jpeg' || ext === '.png';
}


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

            try {

                if (shouldCompress(file.originalname)) {
                    const outputFileName = `${fileNameWithoutExt}.webp`;
                    // ... (Compression logic using sharp remains here) ...
                    const compressedBuffer = await sharp(originalPath)
                        .resize({
                            width: settings.maxWidth,
                            height: settings.maxHeight,
                            fit: 'inside', 
                            withoutEnlargement: true 
                        })
                        .webp({ quality: settings.quality, alphaQuality: 100 })
                        .toBuffer()
                        .catch(err => {
                            console.warn(`Sharp failed to read ${file.originalname} for compression. Including as is.`, err.message);
                            // Throw to fall into the catch block and use the non-image logic below
                            throw new Error('Sharp Read Failure'); 
                        });
                    
                    // Append compressed image to zip
                    archive.append(compressedBuffer, { name: outputFileName });

                } else {
                    // --- NON-IMAGE LOGIC (Include as is) ---
                    const outputFileName = file.originalname;
                    
                    // Append the original file stream/buffer without processing
                    const fileStream = fsSync.createReadStream(originalPath);
                    
                    archive.append(fileStream, { name: outputFileName });
                    // Note: The file's original size/extension is preserved here.
                }
            } catch (err) {
                console.error(`Error processing file ${file.originalname}:`, err.message);
                // File is skipped if streaming or reading fails.
            }

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