const esbuild = require('esbuild');
const dotenv = require('dotenv');

// .env ファイルを読み込み（存在しなくてもエラーにならない）
dotenv.config();

// ビルド時に注入する環境変数とデフォルト値
const envDefaults = {
    CHECKOUT_URL_TEST: 'https://buy.stripe.com/test_placeholder',
    CHECKOUT_URL_LIVE: '',
    LICENSE_API_BASE: 'https://anticrow.pages.dev',
};

// esbuild の define オプション用にフォーマット
const define = {};
for (const [key, defaultValue] of Object.entries(envDefaults)) {
    define[`process.env.${key}`] = JSON.stringify(process.env[key] || defaultValue);
}

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: false,
    minify: true,
    treeShaking: true,
    define,
}).catch(() => process.exit(1));
