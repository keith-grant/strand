/*
 * The Playwright test used by the generated feature tests: each scenario gets a `strand` driver on a fresh page.
 */
import {test as base} from 'playwright-bdd';
import {Strand} from './strand';

export const test = base.extend<{strand: Strand}>({
  strand: async ({page}, use) => {
    const strand = new Strand(page);
    await strand.start();
    await use(strand);
  },
});
