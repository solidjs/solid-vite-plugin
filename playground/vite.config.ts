import solid from '@solidjs/vite-plugin';
import { defineConfig, type PluginOption } from 'vite';

const logPlugin = (): PluginOption => {
  return {
    name: 'looog',
    configResolved(config) {
      console.log({ alias: config.resolve.alias });
    },
  };
};

export default defineConfig({
  plugins: [
    solid({
      babel: {
        plugins: ['@babel/plugin-syntax-top-level-await'],
      },
    }) as unknown as PluginOption,
    logPlugin(),
  ],
  resolve: {
    alias: {
      '@': '/pages',
      '@@': '/assets',
    },
  },
  build: { target: 'esnext' },
});
