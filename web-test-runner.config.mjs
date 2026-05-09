export default {
  concurrency: 4,
  nodeResolve: true,
  files: 'lib/test/**/*-spec.js',
  rootDir: './',
  browserLogs: false,
  filterBrowserLogs: (log) => log.type === 'error',
  testRunnerHtml: (testFramework) => `
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
    </head>
    <body>
      <script type="module" src="${testFramework}"></script>
    </body>
  </html>`,
  testsFinishTimeout: 300000,
  testFramework: {
    config: {
      ui: 'tdd',
      timeout: '120000',
    },
  },
};
