import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../lib/store.mjs';
import { recallBlock, tokens, recall } from '../lib/recall.mjs';

const dir = mkdtempSync(join(tmpdir(), 'petdbg-'));
const s = new MemoryStore(dir);
s.addFact({ kind: 'preference', text: '他喜欢吃辣', salience: 4 });
console.log('tokens吃=', JSON.stringify([...tokens('吃')]));
console.log('recall=', JSON.stringify(recall(s, '吃', { limit: 4 })));
console.log('block=', JSON.stringify(recallBlock(s, '吃')));
rmSync(dir, { recursive: true, force: true });