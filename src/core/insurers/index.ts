// Registry of supported insurer modules. Adding an insurer = one module + one line here.
import type { InsurerId } from '../types';
import type { InsurerModule } from './module';
import { module as godigit } from './godigit';
import { module as hdfcErgo } from './hdfc-ergo';
import { module as reliance } from './reliance';
import { module as tataAig } from './tata-aig';

export const MODULES: readonly InsurerModule[] = [hdfcErgo, reliance, godigit, tataAig];

export function moduleFor(id: InsurerId): InsurerModule | undefined {
  return MODULES.find((m) => m.id === id);
}
