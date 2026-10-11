import React from 'react';
import { createRoot } from 'react-dom/client';
import { Agentation } from 'https://esm.sh/agentation@3.1.2?external=react,react-dom';

const container = document.createElement('div');
container.id = 'agentation-root';
document.body.appendChild(container);

createRoot(container).render(
  React.createElement(Agentation, { reactComponents: false })
);
