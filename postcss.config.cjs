const path = require('path')

module.exports = {
  plugins: [
    require('postcss-import')({
      path: [path.resolve(__dirname, '../node_modules')],
    }),
  ],
}
