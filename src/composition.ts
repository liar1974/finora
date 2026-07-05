import { FinanceService } from './application/finance-service.js';
import { loadConfig, type Config } from './config.js';
import { LocalModelEngine } from './infrastructure/local-model.js';
import { CsvStatementParser } from './infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from './infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from './infrastructure/sqlite-repository.js';

export function createApplication(config: Config = loadConfig()): FinanceService {
  return new FinanceService(
    new SqliteFinanceRepository(config.databasePath),
    [new OfxStatementParser(), new CsvStatementParser()],
    new LocalModelEngine(config.modelsDir),
  );
}
