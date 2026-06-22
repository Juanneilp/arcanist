module.exports = {
  apps: [
    {
      name: 'arcanistmain',
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
