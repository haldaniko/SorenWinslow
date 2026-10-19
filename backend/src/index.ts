import { ensureSchema } from './services/db';
import { migrateLegacyDataIfNeeded } from './services/legacyDataMigration';
import { startGenerationScheduler } from './services/generationScheduler';
import { createApp } from './app';

const port = Number(process.env.PORT || 4000);

async function main() {
  await ensureSchema();
  await migrateLegacyDataIfNeeded();
  startGenerationScheduler();
  const app = createApp();
  app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
