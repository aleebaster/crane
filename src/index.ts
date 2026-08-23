import * as dotenv from 'dotenv';
dotenv.config();

import { run } from './wallet-manager';

const configPath = process.argv[2] || 'config/config.json';

run(configPath).catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
