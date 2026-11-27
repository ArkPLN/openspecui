import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { Button } from '../ui/button';
import { EmptyState } from './EmptyState';
import { InlineAlert } from './InlineAlert';
import { StatusBadge } from './StatusBadge';
import { STAGE_META } from '../../lib/status';

let container: HTMLDivElement;
let root: Root;

test.beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

test.afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

for (const theme of ['dark', 'light'] as const) {
  test(`common components ${theme}`, async () => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    await act(async () => {
      root.render(
        <div className="min-h-screen space-y-4 bg-background p-6 text-foreground">
          <Button>Primary action</Button>
          <StatusBadge meta={STAGE_META.complete}>Complete</StatusBadge>
          <InlineAlert variant="warning">Read-only mode</InlineAlert>
          <EmptyState title="No changes" description="Create the first Change" />
        </div>,
      );
    });
    const viewportLabel = window.innerWidth < 768 ? 'mobile' : 'desktop';
    await expect.element(page.getByText('No changes')).toMatchScreenshot(`common-${theme}-${viewportLabel}`, {
      comparatorName: 'pixelmatch',
      comparatorOptions: { allowedMismatchedPixelRatio: 0.01 },
    });
  });
}
