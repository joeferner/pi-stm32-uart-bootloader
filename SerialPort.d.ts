interface SerialPort {
    open(callback: (err) => void): void;
    close(callback: (err) => void): void;
    write(buffer: Buffer, callback: any): void;

    removeAllListeners(name: string): void;
    on(name: string, callback: (data) => void): void;
}
