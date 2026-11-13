'use strict';
/*
 * Importa registros de um arquivo JSON para o banco.
 * Uso: DATABASE_URL=postgres://... node server/import.js data/exemplo.json
 * Formato: { "clientes": [ {id, ...} ], "visitas": [...], "leads": [...], "equipe": [...] }
 * Registros com o mesmo id são sobrescritos.
 */
const fs = require('node:fs');
const config = require('./config');
const { createStore, COLLECTIONS } = require('./store');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Uso: node server/import.js <arquivo.json>'); process.exit(1); }
  if (!config.databaseUrl) { console.error('Defina DATABASE_URL para importar no PostgreSQL.'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = createStore(config);
  await store.init();
  let n = 0;
  for (const col of COLLECTIONS) {
    for (const doc of data[col] || []) {
      const { id, ...body } = doc;
      if (!id) continue;
      await store.put(col, id, body, 'import');
      n++;
    }
  }
  await store.close();
  console.log(`${n} registros importados de ${file}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
