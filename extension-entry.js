// @ts-check

'use strict'

module.exports = require(
  process.env.NODE_ENV === 'development'
    ? './out/extension.js'
    : './dist/extension.js'
)
