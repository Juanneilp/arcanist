module.exports = {
  apps: [
    {
      name: 'arcanist',
      script: './bot/main.cjs',
      watch: false,
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
