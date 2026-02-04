import path from 'node:path';
import { fetchPlugin } from 'obsidian-e2e-toolkit';

export default async function globalSetup() {
  const dest = path.resolve(process.cwd(), 'myfiles', 'obsidian42-brat');
  await fetchPlugin('https://github.com/TfTHacker/obsidian42-brat.git', dest);
}
