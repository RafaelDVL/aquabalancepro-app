/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts,scss}'],
  theme: {
    extend: {
      colors: {
        'ocean-dark': '#05161A',
        'ocean-card': '#072E33',
        'ocean-light': '#294D61',
        'neon-cyan': '#0F969C',
        'teal-dim': '#0C7075',
        'text-main': '#E0E0E0',
        'text-muted': '#6DA5C0',
      },
      backgroundImage: {
        'gradient-pump-1': 'linear-gradient(to right, #2DD4BF, #06B6D4)',
        'gradient-pump-2': 'linear-gradient(to right, #F472B6, #FB923C)',
        'gradient-pump-3': 'linear-gradient(to right, #A855F7, #3B82F6)',
      },
      boxShadow: {
        neon: '0 0 12px rgba(15, 150, 156, 0.6)',
      },
    },
  },
  plugins: [],
};
