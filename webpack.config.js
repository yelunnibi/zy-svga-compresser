//@ts-check

"use strict";

const path = require("path");
const webpack = require("webpack");
const CopyPlugin = require("copy-webpack-plugin");

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: "node", // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
  mode: "none", // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: "./src/extension.ts", // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode", // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: [".ts", ".js"],
    alias: {
      "@root/*": path.resolve(__dirname),
      "@src/*": path.resolve(__dirname, "src"),
      "@modules": path.resolve(__dirname, "src/modules"),
      "@image-compressor": path.resolve(__dirname, "src/modules/image-compressor"),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "ts-loader",
          },
        ],
      },
      {
        test: /\.node$/,
        loader: "node-loader",
        options: {
          // 关键：保留 node_modules/sharp/build/Release/ 目录层级。
          // sharp 的原生模块用 @loader_path/../../vendor/<版本>/<平台>/lib 定位 libvips，
          // 只有落在 build/Release/ 下，这个相对路径才能解析到我们随包分发的 vendor 目录。
          // 若用默认的 [contenthash].[ext]，模块会落在 dist/ 根目录，rpath 会逃出扩展目录，
          // 导致 macOS/Linux 上加载 libvips 失败。
          name: "node_modules/sharp/build/Release/[name].[ext]",
        },
      },
    ],
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
  plugins: [
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
    }),
    new CopyPlugin({
      patterns: [
        // libvips 动态库：目录层级必须与原生模块的 rpath 约定一致（vendor/<版本>/<平台>/lib）
        {
          from: "./node_modules/sharp/vendor",
          to: "node_modules/sharp/vendor",
          noErrorOnMissing: true,
          // include/ 下只有 C 头文件，运行时用不到，排除以控制包体积
          filter: (resourcePath) => !/[\\/]include[\\/]/.test(resourcePath),
        },
        // Windows 的 DLL 需要与 .node 同目录（Windows 会优先在加载模块所在目录查找 DLL）
        {
          from: "./assets/native-node",
          to: "node_modules/sharp/build/Release",
          noErrorOnMissing: true,
          filter: (resourcePath) => resourcePath.endsWith(".dll"),
        },
      ],
    }),
  ],
};
module.exports = [extensionConfig];
