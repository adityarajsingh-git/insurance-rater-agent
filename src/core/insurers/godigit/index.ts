import type { InsurerModule } from '../module';
import { detect, extract } from './extract';
import { resolve } from './resolve';

export const module: InsurerModule = { id: 'godigit', displayName: 'Go Digit General Insurance', detect, extract, resolve };
