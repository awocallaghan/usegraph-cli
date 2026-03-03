import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@acme/ui';

function App() {
  return (
    <div>
      <Button variant="primary">Hello</Button>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
