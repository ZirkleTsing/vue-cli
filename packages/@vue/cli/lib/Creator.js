const path = require('path')
const chalk = require('chalk')
const debug = require('debug')
const execa = require('execa')
const inquirer = require('inquirer')
const semver = require('semver')
const EventEmitter = require('events')
const Generator = require('./Generator')
const cloneDeep = require('lodash.clonedeep')
const sortObject = require('./util/sortObject')
const getVersions = require('./util/getVersions')
const { installDeps } = require('./util/installDeps')
const { clearConsole } = require('./util/clearConsole')
const PromptModuleAPI = require('./PromptModuleAPI')
const writeFileTree = require('./util/writeFileTree')
const { formatFeatures } = require('./util/features')
const loadLocalPreset = require('./util/loadLocalPreset')
const loadRemotePreset = require('./util/loadRemotePreset')
const generateReadme = require('./util/generateReadme')

const {
  defaults,
  saveOptions,
  loadOptions,
  savePreset,
  validatePreset
} = require('./options')

const {
  log,
  warn,
  error,
  hasGit,
  hasProjectGit,
  hasYarn,
  hasPnpm3OrLater,
  logWithSpinner,
  stopSpinner,
  exit,
  loadModule
} = require('@vue/cli-shared-utils')

const isManualMode = answers => answers.preset === '__manual__'

module.exports = class Creator extends EventEmitter {
  constructor(name, context, promptModules) {
    // name: 项目文件夹的名字
    // context: 这个项目的绝对路径
    super()

    this.name = name
    this.context = process.env.VUE_CLI_CONTEXT = context
    const { presetPrompt, featurePrompt } = this.resolveIntroPrompts()
    this.presetPrompt = presetPrompt
    this.featurePrompt = featurePrompt
    this.outroPrompts = this.resolveOutroPrompts()
    this.injectedPrompts = [] // 等待PromptModuleAPI注入
    this.promptCompleteCbs = [] // 根据答案遍历注册的回调，cb => cb(answers, preset),操作preset
    this.createCompleteCbs = [] // 等待PromptModuleAPI注入

    this.run = this.run.bind(this) // create()里可以解构使用run()

    const promptAPI = new PromptModuleAPI(this)
    /**这个实例拥有了很多api, PromptModuleAPI可以访问到this
     * 将插件feature注入到featurePrompt.choices
     *
     *  */
    promptModules.forEach(m => m(promptAPI)) // 通过访问promptAPI可以注入配置
    // [ require('...'), require('...')]
    //  .forEach(module => module( key )) //key可以拥有很多操纵this的API
  }

  async create(cliOptions = {}, preset = null) {
    const isTestOrDebug = process.env.VUE_CLI_TEST || process.env.VUE_CLI_DEBUG
    const { run, name, context, createCompleteCbs } = this

    if (!preset) {
      if (cliOptions.preset) { // preset有值  (default | <presetName>)
        // vue create foo --preset bar      // --preset <presetName> Skip prompts and use saved or remote preset
        // --clone', 'Use git clone when fetching remote preset'
        preset = await this.resolvePreset(cliOptions.preset, cliOptions.clone)  // 解析一下脚手架预制的配置或者远程拉取
      } else if (cliOptions.default) {
        // vue create foo --default
        preset = defaults.presets.default
        /**
         * 如果没有指定-p <presetName>， 再去检查default字段，
         * defaults是cli提供的一个默认的presetSchema
         * {
            lastChecked: undefined,
            latestVersion: undefined,

            packageManager: undefined,
            useTaobaoRegistry: undefined,
            presets: {
              'default': {
                router: false,
                vuex: false,
                useConfigFiles: false,
                cssPreprocessor: undefined,
                plugins: {
                  '@vue/cli-plugin-babel': {},
                  '@vue/cli-plugin-eslint': {
                    config: 'base',
                    lintOn: ['save']
                  }
                }
              }
            }
          }
        */
      } else if (cliOptions.inlinePreset) {
        // vue create foo --inlinePreset {...}
        try {
          preset = JSON.parse(cliOptions.inlinePreset)
        } catch (e) {
          error(`CLI inline preset is not valid JSON: ${cliOptions.inlinePreset}`)
          exit(1)
        }
      } else {
        preset = await this.promptAndResolvePreset() // 【关键】提示并且解析preset，如果上述都不符合，则给一个默认的配置
      }
    }

    // clone before mutating
    preset = cloneDeep(preslatestet)
    // inject core service
    preset.plugins['@vue/cli-service'] = Object.assign({
      projectName: name
    }, preset)
    if (cliOptions.bare) {
      preset.plugins['@vue/cli-service'].bare = true
    }

    const packageManager = (
      cliOptions.packageManager || // 命令行
      loadOptions().packageManager ||   // ~/.vuerc
      (hasYarn() ? 'yarn' : null) || //\\\
      (hasPnpm3OrLater() ? 'pnpm' : 'npm')
    )

    await clearConsole()
    logWithSpinner(`✨`, `Creating project in ${chalk.yellow(context)}.`)
    this.emit('creation', { event: 'creating' })

    // get latest CLI version
    const { current, latest } = await getVersions()  // cli当前的版本 和 远端最新的版本
    let latestMinor = `${semver.major(latest)}.${semver.minor(latest)}.0`

    // if using `next` branch of cli
    if (semver.gt(current, latest) && semver.prerelease(current)) {
      latestMinor = current
    }
    // generate package.json with plugin dependencies
    const pkg = {
      name,
      version: '0.1.0',
      private: true,
      devDependencies: {}
    }
    const deps = Object.keys(preset.plugins)
    deps.forEach(dep => {
      if (preset.plugins[dep]._isPreset) {
        return
      }

      // Note: the default creator includes no more than `@vue/cli-*` & `@vue/babel-preset-env`,
      // so it is fine to only test `@vue` prefix.
      // Other `@vue/*` packages' version may not be in sync with the cli itself.
      pkg.devDependencies[dep] = (
        preset.plugins[dep].version ||
        ((/^@vue/.test(dep)) ? `^${latestMinor}` : `latest`)
      )
    })
    // write package.json  // 生成package.json
    await writeFileTree(context, {
      'package.json': JSON.stringify(pkg, null, 2) // JSON.stringify(value[, replacer [, space]])
    })

    // intilaize git repository before installing deps
    // so that vue-cli-service can setup git hooks.
    const shouldInitGit = this.shouldInitGit(cliOptions)
    if (shouldInitGit) {
      logWithSpinner(`🗃`, `Initializing git repository...`)
      this.emit('creation', { event: 'git-init' }) // https://github.com/vuejs/vue-cli/issues/2933 源码疑惑 https://github.com/vuejs/vue-cli/blob/dev/packages/@vue/cli-ui/apollo-server/connectors/projects.js#L95 // apollo-server
      await run('git init')
    }

    // install plugins
    stopSpinner()
    log(`⚙  Installing CLI plugins. This might take a while...`)
    log()
    this.emit('creation', { event: 'plugins-install' })
    if (isTestOrDebug) {
      // in development, avoid installation process
      await require('./util/setupDevProject')(context)
    } else {
      await installDeps(context, packageManager, cliOptions.registry)
    }

    // run generator
    log(`🚀  Invoking generators...`)
    this.emit('creation', { event: 'invoking-generators' })
    const plugins = await this.resolvePlugins(preset.plugins)
    const generator = new Generator(context, {
      pkg,
      plugins,
      completeCbs: createCompleteCbs
    })
    await generator.generate({
      extractConfigFiles: preset.useConfigFiles
    })

    // install additional deps (injected by generators)
    log(`📦  Installing additional dependencies...`)
    this.emit('creation', { event: 'deps-install' })
    log()
    if (!isTestOrDebug) {
      await installDeps(context, packageManager, cliOptions.registry)
    }

    // run complete cbs if any (injected by generators)
    logWithSpinner('⚓', `Running completion hooks...`)
    this.emit('creation', { event: 'completion-hooks' })
    for (const cb of createCompleteCbs) {
      await cb()
    }

    // generate README.md
    stopSpinner()
    log()
    logWithSpinner('📄', 'Generating README.md...')
    await writeFileTree(context, {
      'README.md': generateReadme(generator.pkg, packageManager)
    })

    // generate a .npmrc file for pnpm, to persist the `shamefully-flatten` flag
    if (packageManager === 'pnpm') {
      await writeFileTree(context, {
        '.npmrc': 'shamefully-flatten=true\n'
      })
    }

    // commit initial state
    let gitCommitFailed = false
    if (shouldInitGit) {
      await run('git add -A')
      if (isTestOrDebug) {
        await run('git', ['config', 'user.name', 'test'])
        await run('git', ['config', 'user.email', 'test@test.com'])
      }
      const msg = typeof cliOptions.git === 'string' ? cliOptions.git : 'init'
      try {
        await run('git', ['commit', '-m', msg])
      } catch (e) {
        gitCommitFailed = true
      }
    }

    // log instructions
    stopSpinner()
    log()
    log(`🎉  Successfully created project ${chalk.yellow(name)}.`)
    if (!cliOptions.skipGetStarted) {
      log(
        `👉  Get started with the following commands:\n\n` +
        (this.context === process.cwd() ? `` : chalk.cyan(` ${chalk.gray('$')} cd ${name}\n`)) +
        chalk.cyan(` ${chalk.gray('$')} ${packageManager === 'yarn' ? 'yarn serve' : packageManager === 'pnpm' ? 'pnpm run serve' : 'npm run serve'}`)
      )
    }
    log()
    this.emit('creation', { event: 'done' })

    if (gitCommitFailed) {
      warn(
        `Skipped git commit due to missing username and email in git config.\n` +
        `You will need to perform the initial commit yourself.\n`
      )
    }

    generator.printExitLogs()
  }

  run(command, args) {
    if (!args) { [command, ...args] = command.split(/\s+/) }
    return execa(command, args, { cwd: this.context })
  }

  async promptAndResolvePreset(answers = null) {
    // prompt
    if (!answers) {
      await clearConsole(true)
      answers = await inquirer.prompt(this.resolveFinalPrompts())
    }
    debug('vue-cli:answers')(answers)

    if (answers.packageManager) {
      saveOptions({
        packageManager: answers.packageManager
      })
    }

    let preset
    if (answers.preset && answers.preset !== '__manual__') {
      preset = await this.resolvePreset(answers.preset)  //
    } else {
      // manual
      preset = {
        useConfigFiles: answers.useConfigFiles === 'files',
        plugins: {}
      }
      answers.features = answers.features || []
      // run cb registered by prompt modules to finalize the preset
      this.promptCompleteCbs.forEach(cb => cb(answers, preset))
    }

    // validate
    validatePreset(preset)

    // save preset
    if (answers.save && answers.saveName) {
      savePreset(answers.saveName, preset)
    }

    debug('vue-cli:preset')(preset)
    return preset
  }

  async resolvePreset(name, clone) {  // presetName:string clone:boolean
    let preset
    const savedPresets = loadOptions().presets || {}
    /**
    /** ~/.vuerc
     * {
        "useTaobaoRegistry": true,
        "packageManager": "npm",
        "latestVersion": "3.8.4",
        "lastChecked": 1561612781641,
        "preset: {
          plugins: {}
          configs: {}
          [...]
        }
      }
        关于preset的格式:
        const schema = createSchema(joi => joi.object().keys({
          latestVersion: joi.string().regex(/^\d+\.\d+\.\d+$/),
          lastChecked: joi.date().timestamp(),
          packageManager: joi.string().only(['yarn', 'npm', 'pnpm']),
          useTaobaoRegistry: joi.boolean(),
          presets: joi.object().pattern(/^/, presetSchema)
        }))

        const presetSchema = createSchema(joi => joi.object().keys({
          bare: joi.boolean(),
          useConfigFiles: joi.boolean(),
          router: joi.boolean(),
          routerHistoryMode: joi.boolean(),
          vuex: joi.boolean(),
          cssPreprocessor: joi.string().only(['sass', 'dart-sass', 'node-sass', 'less', 'stylus']),
          plugins: joi.object().required(),
          configs: joi.object()
        }))
      }))
     * 被保存的 preset 将会存在用户的 home 目录下一个名为 .vuerc 的 JSON 文件里。如果你想要修改被保存的 preset / 选项，可以编辑这个文件。
       在项目创建的过程中，你也会被提示选择喜欢的包管理器或使用淘宝 npm 镜像源以更快地安装依赖。这些选择也将会存入 ~/.vuerc。
     *  */
    if (name in savedPresets) {
      preset = savedPresets[name]
    } else if (name.endsWith('.json') || /^\./.test(name) || path.isAbsolute(name)) {
      preset = await loadLocalPreset(path.resolve(name))
    } else if (name.includes('/')) {
      logWithSpinner(`Fetching remote preset ${chalk.cyan(name)}...`)
      this.emit('creation', { event: 'fetch-remote-preset' })
      try {
        preset = await loadRemotePreset(name, clone)
        stopSpinner()
      } catch (e) {
        stopSpinner()
        error(`Failed fetching remote preset ${chalk.cyan(name)}:`)
        throw e
      }
    }

    // use default preset if user has not overwritten it
    if (name === 'default' && !preset) {
      preset = defaults.presets.default
    }
    if (!preset) {
      error(`preset "${name}" not found.`)
      const presets = Object.keys(savedPresets)
      if (presets.length) {
        log()
        log(`available presets:\n${presets.join(`\n`)}`)
      } else {
        log(`you don't seem to have any saved preset.`)
        log(`run vue-cli in manual mode to create a preset.`)
      }
      exit(1)
    }
    return preset
  }

  // { id: options } => [{ id, apply, options }]
  async resolvePlugins(rawPlugins) {
    // ensure cli-service is invoked first
    rawPlugins = sortObject(rawPlugins, ['@vue/cli-service'], true)
    const plugins = []
    for (const id of Object.keys(rawPlugins)) {
      const apply = loadModule(`${id}/generator`, this.context) || (() => { })
      let options = rawPlugins[id] || {}
      if (options.prompts) {
        const prompts = loadModule(`${id}/prompts`, this.context)
        if (prompts) {
          log()
          log(`${chalk.cyan(options._isPreset ? `Preset options:` : id)}`)
          options = await inquirer.prompt(prompts)
        }
      }
      plugins.push({ id, apply, options })
    }
    return plugins
  }

  getPresets() {
    const savedOptions = loadOptions()
    return Object.assign({}, savedOptions.presets, defaults.presets)
  }

  resolveIntroPrompts() {
    const presets = this.getPresets()
    /**
     *
     *  {
     *  default: {
          router: false,
          vuex: false,
          useConfigFiles: false,
          cssPreprocessor: undefined,
          plugins: {
            '@vue/cli-plugin-babel': {},
            '@vue/cli-plugin-eslint': {
              config: 'base',
              lintOn: ['save']
            }
          }
        },
        demo1: {
          ...
        }
      }
     *
     *
     *
     *
    */
    const presetChoices = Object.keys(presets).map(name => {
      return {
        name: `${name} (${formatFeatures(presets[name])})`,
        value: name
      }
    })
    const presetPrompt = {
      name: 'preset',
      type: 'list',
      message: `Please pick a preset:`,
      choices: [
        ...presetChoices,   // default 选项
        {
          name: 'Manually select features',  // 手动选项
          value: '__manual__'   // const isManualMode = answers => answers.preset === '__manual__'
        }
      ]
    }
    const featurePrompt = {
      name: 'features',
      when: isManualMode,
      type: 'checkbox',
      message: 'Check the features needed for your project:',
      choices: [],
      pageSize: 10
    }
    return {
      presetPrompt,
      featurePrompt
    }
  }

  resolveOutroPrompts() {
    const outroPrompts = [
      {
        name: 'useConfigFiles',
        when: isManualMode,
        type: 'list',
        message: 'Where do you prefer placing config for Babel, PostCSS, ESLint, etc.?',
        choices: [
          {
            name: 'In dedicated config files',
            value: 'files'
          },
          {
            name: 'In package.json',
            value: 'pkg'
          }
        ]
      },
      {
        name: 'save',
        when: isManualMode,
        type: 'confirm',
        message: 'Save this as a preset for future projects?',
        default: false
      },
      {
        name: 'saveName',
        when: answers => answers.save,
        type: 'input',
        message: 'Save preset as:'
      }
    ]

    // ask for packageManager once
    const savedOptions = loadOptions()
    if (!savedOptions.packageManager && (hasYarn() || hasPnpm3OrLater())) {
      const packageManagerChoices = []

      if (hasYarn()) {
        packageManagerChoices.push({
          name: 'Use Yarn',
          value: 'yarn',
          short: 'Yarn'
        })
      }

      if (hasPnpm3OrLater()) {
        packageManagerChoices.push({
          name: 'Use PNPM',
          value: 'pnpm',
          short: 'PNPM'
        })
      }

      packageManagerChoices.push({
        name: 'Use NPM',
        value: 'npm',
        short: 'NPM'
      })

      outroPrompts.push({
        name: 'packageManager',
        type: 'list',
        message: 'Pick the package manager to use when installing dependencies:',
        choices: packageManagerChoices
      })
    }

    return outroPrompts
  }

  resolveFinalPrompts() {
    // patch generator-injected prompts to only show in manual mode
    this.injectedPrompts.forEach(prompt => {
      const originalWhen = prompt.when || (() => true)
      prompt.when = answers => {
        return isManualMode(answers) && originalWhen(answers)
      }
    })
    const prompts = [
      this.presetPrompt,
      this.featurePrompt, // when isManualMode
      ...this.injectedPrompts, // when isManualMode || originalWhen: eg: answers => answers.features.includes('linter'),
      ...this.outroPrompts  // TODO这是什么
    ]
    debug('vue-cli:prompts')(prompts)
    return prompts
  }

  shouldInitGit(cliOptions) {
    if (!hasGit()) {
      return false
    }
    // --git
    if (cliOptions.forceGit) {
      return true
    }
    // --no-git
    if (cliOptions.git === false || cliOptions.git === 'false') {
      return false
    }
    // default: true unless already in a git repo
    return !hasProjectGit(this.context)
  }
}
