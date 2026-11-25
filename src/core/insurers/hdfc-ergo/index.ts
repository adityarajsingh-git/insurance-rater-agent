// HDFC ERGO insurer module: detection and extraction from the policy schedule, resolution against the
// Feb'25 private-car grid PDF.
import type { InsurerModule } from '../module';
import { detect, extract } from './extract';
import { resolve } from './resolve';

export const module: InsurerModule = { id: 'hdfc-ergo', displayName: 'HDFC ERGO', detect, extract, resolve };
