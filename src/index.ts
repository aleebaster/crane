import * as dotenv from 'dotenv';
dotenv.config();

import { run } from './wallet-manager';

const configPath = process.argv[2] || 'config/config.json';

run(configPath)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFatal:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
