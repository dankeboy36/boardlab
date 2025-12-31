// @ts-check
'use strict'

const path = require('path')

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './packages/extension/src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
}

/** @type {import('webpack').Configuration} */
const portinoBridgeConfig = {
  target: 'node',
  mode: 'none',
  entry: './packages/servers/portino-bridge/out/serviceMain.js',
  output: {
    path: path.resolve(__dirname, 'dist', 'portino-bridge'),
    filename: 'serviceMain.js',
    libraryTarget: 'commonjs2',
  },
  resolve: {
    extensions: ['.js'],
  },
  devtool: false,
}

module.exports = [extensionConfig, portinoBridgeConfig]
