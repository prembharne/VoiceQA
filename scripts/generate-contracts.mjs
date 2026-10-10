import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import { readFile, writeFile } from 'node:fs/promises';
const schema = JSON.parse(await readFile('shared/envelope.schema.json', 'utf8'));
const ajv = new Ajv({ code: { source: true, esm: true } });
const validate = ajv.compile(schema);
const source = standalone(ajv, validate).replace(
  'const func2 = require("ajv/dist/runtime/ucs2length").default;',
  'const func2 = (value) => [...value].length;',
);
await writeFile('shared/envelope-validator.js', source);
