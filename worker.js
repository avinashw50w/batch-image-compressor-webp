const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const archiver = require('archiver');
const fsSync = require('fs');

function shouldCompress(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return ['.jpg', '.jpeg', '.png'].includes(ext);
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
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.pipe(output);

        const filesToCleanup = [];

        for (const file of files) {
            const originalPath = path.join(uploadDir, file.originalname);
            const fileNameWithoutExt = path.parse(file.originalname).name;
            filesToCleanup.push(originalPath);

            try {
                if (shouldCompress(file.originalname)) {
                    const outputFileName = `${fileNameWithoutExt}.webp`;

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
                            console.warn(`Sharp failed to read ${file.originalname}. Including as is.`, err.message);
                            throw new Error('Sharp Read Failure');
                        });

                    archive.append(compressedBuffer, { name: outputFileName });
                } else {
                    const fileBuffer = await fs.readFile(originalPath);
                    archive.append(fileBuffer, { name: file.originalname });
                }
            } catch (err) {
                console.error(`Error processing file ${file.originalname}:`, err.message);
            }

            completedCount++;
            parentPort.postMessage({ type: 'progress', completed: completedCount });
        }

        await archive.finalize();

        output.on('close', async () => {
            for (const filePath of filesToCleanup) {
                await fs.unlink(filePath).catch(console.error);
            }
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