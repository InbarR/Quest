import * as path from 'path';
import Mocha from 'mocha';
import * as glob from 'glob';

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 60000 // 60 second timeout for extension tests
    });

    const testsRoot = path.resolve(__dirname, '.');

    return new Promise((resolve, reject) => {
        // Use synchronous glob for simplicity
        const files = glob.sync('**/*.test.js', { cwd: testsRoot });

        // Add files to the test suite
        files.forEach((file: string) => {
            mocha.addFile(path.resolve(testsRoot, file));
        });

        try {
            // Run the mocha test
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error(err);
            reject(err);
        }
    });
}
