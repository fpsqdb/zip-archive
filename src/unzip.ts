import * as yauzl from "yauzl";
import * as exfs from "./fs";
import { WriteStream, createWriteStream } from "fs";
import * as path from "path";
import { Readable } from "stream";
import * as util from "./util";

export interface IExtractOptions {
    /**
     * If it is true, the target directory will be deleted before extract. 
     * The default value is false.
     */
    overwrite?: boolean;
    /**
     * Extract symbolic links as files on windows.
     * The default value is true.
     * 
     * On windows, the default security policy allows only administrators to create symbolic links.
     * 
     * When symlinkAsFileOnWindows is set to true, the symlink in the zip archive will be extracted as a normal file on Windows. 
     * When symlinkAsFileOnWindows is set to false, if the zip contains symlink, an EPERM error will be thrown under non-administrators.
     */
    symlinkAsFileOnWindows?: boolean
    /**
     * Called before an item is extracted.
     * @param event 
     */
    onEntry?: (event: IEntryEvent) => void;
}

/**
 * The IEntryEvent interface represents an event that an entry is about to be extracted.
 */
export interface IEntryEvent {
    /**
     * Entry name.
     */
    readonly entryName: string;
    /**
     * Total number of entries.
     */
    readonly entryCount: number;
    /**
     * Prevent extracting current entry.
     */
    preventDefault(): void;
}

class EntryEvent implements IEntryEvent {
    /**
     *
     */
    constructor(private _entryCount: number) {
        
    }
    private _entryName: string;
    get entryName(): string {
        return this._entryName;
    }
    set entryName(name: string) {
        this._entryName = name;
    }

    get entryCount(): number {
        return this._entryCount;
    }

    private _isPrevented: boolean = false;
    get isPrevented(): boolean {
        return this._isPrevented;
    }

    public preventDefault(): void {
        this._isPrevented = true;
    }

    public reset(): void {
        this._isPrevented = false;
    }
}

/**
 * Extract the zip file.
 */
export class Unzip {
    /**
     *
     */
    constructor(private options?: IExtractOptions) {

    }

    private isCanceled: boolean = false;
    private zipFile: yauzl.ZipFile | null;

    private cancelCallback?: (error: any) => void;
    /**
     * Extract the zip file to the specified location.
     * @param zipFile 
     * @param targetFolder 
     * @param options
     */
    public async extract(zipFile: string, targetFolder: string): Promise<void> {
        let extractedEntriesCount: number = 0;
        this.isCanceled = false;
        if (this.isOverwrite()) {
            await exfs.rimraf(targetFolder);
        }
        if (this.isCanceled) {
            return Promise.reject(this.canceled());
        }
        await exfs.ensureFolder(targetFolder);
        const zfile = await this.openZip(zipFile);
        this.zipFile = zfile;
        zfile.readEntry();
        return new Promise<void>((c, e) => {
            const total: number = zfile.entryCount;
            zfile.once("error", (err) => {
                // Error: EBADF: bad file descriptor, read
                // EBADF error may occur when calling the cancel method
                // Ignore the error if the `cancel` method has been called
                if (this.isCanceled) {
                    e(this.canceled());
                }
                else {
                    e(err);
                }
            });
            zfile.once("close", () => {
                if (this.isCanceled) {
                    e(this.canceled());
                }
                // If the zip content is empty, it will not receive the `zfile.on("entry")` event.
                else if (total === 0) {
                    c(void 0);
                }
            });
            // Because openZip is an asynchronous method, openZip may not be completed when calling cancel, 
            // so we need to check if it has been canceled after the openZip method returns.
            if (this.isCanceled) {
                this.closeZip();
                return;
            }
            const entryEvent: EntryEvent = new EntryEvent(total);
            zfile.on("entry", async (entry: yauzl.Entry) => {
                // use UTF-8 in all situations
                // see https://github.com/thejoshwolfe/yauzl/issues/84
                const rawName = (entry.fileName as any as Buffer).toString("utf8")
                // allow backslash
                const fileName = rawName.replace(/\\/g, "/");
                entryEvent.entryName = fileName;
                this.onEntryCallback(entryEvent);
                try {
                    if (entryEvent.isPrevented) {
                        entryEvent.reset();
                        zfile.readEntry();
                    } else {
                        await this.handleEntry(zfile, entry, fileName, targetFolder);
                    }
                    extractedEntriesCount++;
                    if (extractedEntriesCount === total) {
                        c();
                    }
                } catch (error) {
                    if (this.isCanceled) {
                        e(this.canceled());
                    } else {
                        e(error);
                        this.closeZip();
                    }
                }
            });
        });
    }

    /**
     * Cancel decompression.
     * If the cancel method is called after the extract is complete, nothing will happen.
     */
    public cancel(): void {
        this.isCanceled = true;
        if (this.cancelCallback) {
            this.cancelCallback(this.canceled());
        }
        this.closeZip();
    }

    private closeZip(): void {
        if (this.zipFile) {
            this.zipFile.close();
            this.zipFile = null;
        }
    }

    private openZip(zipFile: string): Promise<yauzl.ZipFile> {
        return new Promise<yauzl.ZipFile>((c, e) => {
            yauzl.open(zipFile, {
                lazyEntries: true,
                // see https://github.com/thejoshwolfe/yauzl/issues/84
                decodeStrings: false
            }, (err, zfile) => {
                if (err) {
                    e(err);
                } else {
                    c(zfile!)
                }
            });
        });
    }

    private async handleEntry(zfile: yauzl.ZipFile, entry: yauzl.Entry, decodeEntryFileName: string, targetPath: string): Promise<void> {
        if (/\/$/.test(decodeEntryFileName)) {
            // Directory file names end with '/'.
            // Note that entires for directories themselves are optional.
            // An entry's fileName implicitly requires its parent directories to exist.
            await exfs.ensureFolder(path.join(targetPath, decodeEntryFileName));
            zfile.readEntry();
        } else {
            // file entry
            await this.extractEntry(zfile, entry, decodeEntryFileName, targetPath);
        }
    }

    private openZipFileStream(zfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
        return new Promise<Readable>((c, e) => {
            zfile.openReadStream(entry, (err, readStream) => {
                if (err) {
                    e(err);
                } else {
                    c(readStream!);
                }
            });
        });
    }

    private async extractEntry(zfile: yauzl.ZipFile, entry: yauzl.Entry, decodeEntryFileName: string, targetPath: string): Promise<void> {
        const filePath = path.join(targetPath, decodeEntryFileName);
        await exfs.ensureFolder(path.dirname(filePath));
        const readStream = await this.openZipFileStream(zfile, entry);
        readStream.on("end", () => {
            zfile.readEntry();
        });
        await this.writeEntryToFile(readStream, entry, filePath);
    }

    private async writeEntryToFile(readStream: Readable, entry: yauzl.Entry, filePath: string): Promise<void> {
        let fileStream: WriteStream;
        this.cancelCallback = (err) => {
            this.cancelCallback = undefined;
            if (fileStream) {
                readStream.unpipe(fileStream);
                fileStream.destroy(err);
            }
        };
        return new Promise<void>(async (c, e) => {
            try {
                const mode = this.modeFromEntry(entry);
                // see https://unix.stackexchange.com/questions/193465/what-file-mode-is-a-symlink
                const isSymlink = ((mode & 0o170000) === 0o120000);
                readStream.once("error", e);

                if (isSymlink && !this.symlinkToFile()) {
                    let linkContent: string = "";
                    readStream.on("data", (chunk: string | Buffer) => {
                        if (chunk instanceof String) {
                            linkContent += chunk;
                        } else {
                            linkContent += chunk.toString();
                        }
                    });
                    readStream.once("end", () => {
                        this.createSymlink(linkContent, filePath).then(c, e);
                    })
                } else {
                    fileStream = createWriteStream(filePath, { mode });
                    fileStream.once("close", () => c());
                    fileStream.once("error", e);
                    readStream.pipe(fileStream);
                }
            } catch (error) {
                e(error);
            }
        });
    }

    private modeFromEntry(entry: yauzl.Entry): number {
        const attr = entry.externalFileAttributes >> 16 || 33188;

        return [448 /* S_IRWXU */, 56 /* S_IRWXG */, 7 /* S_IRWXO */]
            .map(mask => attr & mask)
            .reduce((a, b) => a + b, attr & 61440 /* S_IFMT */);
    }

    private async createSymlink(linkContent: string, des: string): Promise<void> {
        await util.symlink(linkContent, des);
    }

    /**
     * Returns an error that signals cancellation.
     */
    private canceled(): Error {
        let error = new Error("Canceled");
        error.name = error.message;
        return error;
    }

    private isOverwrite(): boolean {
        if (this.options &&
            this.options.overwrite) {
            return true;
        }
        return false;
    }

    private onEntryCallback(event: IEntryEvent): void {
        if (this.options && this.options.onEntry) {
            this.options.onEntry(event);
        }
    }

    private symlinkToFile(): boolean {
        let symlinkToFile: boolean = false;
        if (process.platform === "win32") {
            if (this.options &&
                this.options.symlinkAsFileOnWindows === false) {
                symlinkToFile = false;
            } else {
                symlinkToFile = true;
            }
        }
        return symlinkToFile;
    }
}