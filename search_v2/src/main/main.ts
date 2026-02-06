import * as path from 'path';

process.env.SEARCH_PIPELINE = 'v2';

const rootMainPath = path.join(__dirname, '../../main/main.js');
require(rootMainPath);
