// scripts/parsers/directives/index.ts
// Side-effect: registers all tutorial directive families.
// Import in compose.ts to activate directives in the pipeline.
import { registerFigureDirectives } from './figure.js';
registerFigureDirectives();
