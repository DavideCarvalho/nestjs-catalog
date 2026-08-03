import { registerChartRenderer } from '@dudousxd/nestjs-catalog-react';
import { BklitRenderer } from '@dudousxd/nestjs-catalog-react/bklit';
import { ShadcnChartRenderer } from '@dudousxd/nestjs-catalog-react/recharts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Two renderers, registered by name, and a saved query picks one.
//
// The library itself takes no chart dependency — it ships a CSS-only renderer
// and a registry. Recharts and visx are both larger than everything in that
// package put together, so bundling either would make every consumer pay for a
// choice only some of them want. This console installs both and says so.
//
// "shadcn" is the vendored shadcn/ui chart primitives over Recharts; "bklit"
// is bklit-ui's own charts, vendored into the library under its MIT licence.
registerChartRenderer('shadcn', ShadcnChartRenderer);
registerChartRenderer('bklit', BklitRenderer);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

const root = document.getElementById('root');
if (!root) throw new Error('No #root element to mount the console into.');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
