/**
 * RC Capture design tokens — mirrors VeloDocs web (emerald + amber palette).
 * Derived from artifacts/doc-ingest/src/index.css
 */

const colors = {
  light: {
    // Core surfaces
    background: '#f8faf9',
    foreground: '#0d261e',

    // Cards / elevated surfaces
    card: '#ffffff',
    cardForeground: '#0d261e',
    cardBorder: '#daeae4',

    // Primary action — emerald
    primary: '#0ea472',
    primaryForeground: '#f0fdf8',

    // Secondary
    secondary: '#eef4f1',
    secondaryForeground: '#1c3d2f',

    // Muted / subdued
    muted: '#eef4f1',
    mutedForeground: '#547a6c',

    // Accent highlights
    accent: '#cef5e8',
    accentForeground: '#0a7d4f',

    // Destructive
    destructive: '#f03434',
    destructiveForeground: '#ffffff',

    // Borders / inputs
    border: '#d9e8e3',
    input: '#d9e8e3',

    // Amber — low-confidence highlight
    amber: '#f59f0a',
    amberForeground: '#1f1200',
    amberBackground: '#fef9ea',
    amberBorder: '#f5c842',

    // Legacy aliases
    text: '#0d261e',
    tint: '#0ea472',
  },
  dark: {
    background: '#071510',
    foreground: '#e0e8e5',

    card: '#091e18',
    cardForeground: '#e0e8e5',
    cardBorder: '#163d2e',

    primary: '#0fcb7a',
    primaryForeground: '#0d261e',

    secondary: '#163d2e',
    secondaryForeground: '#e0e8e5',

    muted: '#163d2e',
    mutedForeground: '#8db3a5',

    accent: '#053d25',
    accentForeground: '#a8f5d9',

    destructive: '#7d1a1a',
    destructiveForeground: '#e0e8e5',

    border: '#163d2e',
    input: '#163d2e',

    amber: '#f59f0a',
    amberForeground: '#1f1200',
    amberBackground: '#2a1e00',
    amberBorder: '#a06800',

    text: '#e0e8e5',
    tint: '#0fcb7a',
  },

  // Border radius in px — matches VeloDocs --radius: 0.375rem ≈ 6px
  radius: 6,
};

export default colors;
