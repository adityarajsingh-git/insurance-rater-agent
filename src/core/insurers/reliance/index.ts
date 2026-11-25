// Reliance General (IndusInd) private-car module: Reliance Broking Premier FEB 26 grid.
import type { InsurerModule } from '../module';
import { detect, extract } from './extract';
import { resolve } from './resolve';

export const module: InsurerModule = { id: 'reliance', displayName: 'Reliance General Insurance', detect, extract, resolve };
