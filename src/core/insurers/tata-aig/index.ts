import type { InsurerModule } from '../module';
import { detect, extract } from './extract';
import { resolve } from './resolve';

export const module: InsurerModule = { id: 'tata-aig', displayName: 'Tata AIG', detect, extract, resolve };
