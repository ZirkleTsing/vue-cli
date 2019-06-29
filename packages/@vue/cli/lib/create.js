const fs = require('fs-extra')
const path = require('path')
const chalk = require('chalk')
const inquirer = require('inquirer')
const Creator = require('./Creator')
const { clearConsole } = require('./util/clearConsole')
const { getPromptModules } = require('./util/createTools')
const { error, stopSpinner, exit } = require('@vue/cli-shared-utils')
const validateProjectName = require('validate-npm-package-name')

async function create(projectName, options) {  // projectName是要创建的项目的root文件夹
  if (options.proxy) {
    process.env.HTTP_PROXY = options.proxy  // usr/local/bin/node_modules/   npm-config
    /**用于传出http请求的代理。 如果HTTP_PROXY或设置了http_proxy环境变量，底层请求库将遵循代理设置。
     * A proxy to use for outgoing http requests\. If the HTTP_PROXY or
      http_proxy environment variables are set, proxy settings will be honored by the underlying request library.
     *  */
    // eg : npm config set proxy http://proxy.company.com:8080 --global
  }
  const cwd = options.cwd || process.cwd()
  const inCurrent = projectName === '.'
  const name = inCurrent ? path.relative('../', cwd) : projectName   //项目文件夹的名字: 如果是'.',则算出当前文件夹的< 名字 >，如果不是当前文件夹，则就是输入的文件夹的名字
  const targetDir = path.resolve(cwd, projectName || '.')  // 算出这个项目的绝对路径

  const result = validateProjectName(name) // give me a string and I'll tell you if it's a valid npm package name.
  if (!result.validForNewPackages) { // validForNewPackages , validForOldPackages
    console.error(chalk.red(`Invalid project name: "${name}"`))
    result.errors && result.errors.forEach(err => {
      console.error(chalk.red.dim('Error: ' + err)) // dim 暗淡颜色
    })
    result.warnings && result.warnings.forEach(warn => {
      console.error(chalk.red.dim('Warning: ' + warn))
    })
    exit(1)    // process.exit(code)
  }

  if (fs.existsSync(targetDir)) {  // 如果存在项目绝对路径对应的文件夹
    if (options.force) {  // 检查force标志位 Overwrite target directory if it exists
      await fs.remove(targetDir)  // 异步的删除
    } else {
      await clearConsole()
      if (inCurrent) {
        const { ok } = await inquirer.prompt([
          {
            name: 'ok',
            type: 'confirm',
            message: `Generate project in current directory?`
          }
        ])
        if (!ok) {
          return
        }
      } else {
        const { action } = await inquirer.prompt([
          {
            name: 'action',
            type: 'list',
            message: `Target directory ${chalk.cyan(targetDir)} already exists. Pick an action:`,
            choices: [
              { name: 'Overwrite', value: 'overwrite' },
              { name: 'Merge', value: 'merge' },
              { name: 'Cancel', value: false }
            ]
          }
        ])
        if (!action) {
          return
        } else if (action === 'overwrite') {
          console.log(`\nRemoving ${chalk.cyan(targetDir)}...`)
          await fs.remove(targetDir)
        }
      }
    }
  }

  const creator = new Creator(name, targetDir, getPromptModules())
  await creator.create(options)
}

module.exports = (...args) => {
  return create(...args).catch(err => {
    stopSpinner(false) // do not persist
    error(err)
    if (!process.env.VUE_CLI_TEST) {
      process.exit(1)
    }
  })
}
