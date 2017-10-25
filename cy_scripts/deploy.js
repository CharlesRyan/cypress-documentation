/* eslint-disable no-console */

const _          = require('lodash')
const path       = require('path')
const gift       = require('gift')
// const gulp       = require('gulp')
const chalk      = require('chalk')
// const human      = require('human-interval')
const Promise    = require('bluebird')
const inquirer   = require('inquirer')
// const awspublish = require('gulp-awspublish')
// const parallelize = require('concurrent-transform')
const minimist   = require('minimist')
const debug = require('debug')('deploy')
const questionsRemain = require('@cypress/questions-remain')
const scrape     = require('./scrape')
const shouldDeploy = require('./should-deploy')
// const { configFromEnvOrJsonFile } = require('@cypress/env-or-json-file')
const R = require('ramda')
const la = require('lazy-ass')
const is = require('check-more-types')
const git = require('ggit')
const {
  warnIfNotCI,
  getDeployEnvironment,
  checkBranchEnvFolder,
  getS3Config,
  getS3Publisher,
  publishToS3,
} = require('@cypress/deploy-bits')

const distDir = path.resolve('public')
const isValidEnvironment = is.oneOf(['production', 'staging'])

// initialize on existing repo
const repo = Promise.promisifyAll(gift(path.resolve('..')))

// function getS3Credentials () {
//   const key = path.join('support', '.aws-credentials.json')
//   const config = configFromEnvOrJsonFile(key)
//   if (!config) {
//     console.error('⛔️  Cannot find AWS credentials')
//     console.error('Using @cypress/env-or-json-file module')
//     console.error('and key', key)
//     throw new Error('AWS config not found')
//   }
//   return config
// }

function getCurrentBranch () {
  return git.branchName()
}

// function promptForDeployEnvironment () {
//   return prompt({
//     type: 'list',
//     name: 'strategy',
//     message: 'Which environment are you deploying?',
//     choices: [
//       { name: 'Staging',    value: 'staging' },
//       { name: 'Production', value: 'production' },
//     ],
//   })
//   .get('strategy')
// }

function cliOrAsk (property, ask, minimistOptions) {
  // for now isolate the CLI/question logic
  const askRemaining = questionsRemain({
    [property]: ask,
  })
  const options = minimist(process.argv.slice(2), minimistOptions)
  return askRemaining(options).then(R.prop(property))
}

// const getDeployEnvironment = R.partial(cliOrAsk,
//   ['environment', promptForDeployEnvironment])

// function ensureCleanWorkingDirectory () {
//   return repo.statusAsync()
//   .catch((e) => {
//     console.error('Could not get Git status')
//     console.error(e)
//     console.error('assuming clean status')
//     return { clean: true }
//   })
//   .then((status) => {
//     if (!status.clean) {
//       console.log(chalk.red('\nUncommited files:'))

//       _.each(status.files, (props, file) => {
//         console.log(chalk.red(`- ${file}`))
//       })

//       console.log('')

//       throw new Error('Cannot deploy master to production. You must first commit these above files.')
//     }
//   })
// }

// function getPublisher (bucket, key, secret) {
//   return awspublish.create({
//     httpOptions: {
//       timeout: human('10 minutes'),
//     },
//     params: {
//       Bucket: bucket,
//     },
//     accessKeyId: key,
//     secretAccessKey: secret,
//   })
// }

// function publishToS3 (publisher) {
//   const headers = {}

//   return new Promise((resolve, reject) => {
//     const files = path.join(distDir, '**', '*')

//     return gulp.src(files)
//     .pipe(parallelize(publisher.publish(headers), 100))

//     // we dont need to gzip here because cloudflare
//     // will automatically gzip the content for us
//     // after its cached at their edge location
//     // but we should probably gzip the index.html?
//     // .pipe(awspublish.gzip({ext: '.gz'}))

//     .pipe(awspublish.reporter())
//     .on('error', reject)
//     .on('end', resolve)
//   })
// }

// function uploadToS3 (env) {
//   la(isValidEnvironment(env), 'invalid environment', env)
//   const bucketName = `bucket-${env}`
//   return Promise.resolve()
//   .then(getS3Credentials)
//   .then((json) => {
//     la(is.object(json), 'missing S3 credentials object for environment', env)
//     const bucket = json[bucketName]
//     la(is.unemptyString(bucket), 'Could not find a bucket for environment', env)

//     console.log('\n', 'Deploying to:', chalk.green(bucket), '\n')
//     const publisher = getPublisher(bucket, json.key, json.secret)
//     return publisher
//   })
//   .then(publishToS3)
// }

function uploadToS3 (env) {
  la(is.unemptyString(env), 'missing S3 environment', env)
  const config = getS3Config()
  const bucket = config[`bucket-${env}`]
  la(is.unemptyString(bucket), 'Could not find a bucket for environment', env)
  console.log('')
  console.log('Deploying to:', chalk.green(bucket))
  console.log('')

  const publisher = getS3Publisher(bucket, config.key, config.secret)
  la(publisher, 'could not get publisher for bucket', bucket)
  return publishToS3(distDir, publisher)
}

function prompt (questions) {
  return Promise.resolve(inquirer.prompt(questions))
}

function commitMessage (env, branch) {
  const msg = `docs: deployed to ${env} [skip ci]`

  console.log(
    '\n',
    'Committing and pushing to remote origin:',
    '\n',
    chalk.green(`(${branch})`),
    chalk.cyan(msg)
  )

  // commit empty message that we deployed
  return repo.commitAsync(msg, {
    'allow-empty': true,
  })
  .then(function () {
    // and push it to the origin with the current branch
    return repo.remote_pushAsync('origin', branch)
  })
}

function prompToScrape () {
  return prompt({
    type: 'list',
    name: 'scrape',
    message: 'Would you like to scrape the docs? (You only need to do this if they have changed on this deployment)',
    choices: [
      { name: 'Yes', value: true },
      { name: 'No',  value: false },
    ],
  })
  .get('scrape')
}

const getScrapeDocs = R.partial(cliOrAsk,
  ['scrape', prompToScrape, { boolean: 'scrape' }])

function scrapeDocs (env, branch) {
  console.log('')

  // if we aren't on master do nothing
  if (branch !== 'master') {
    console.log('Skipping doc scraping because you are not on branch:', chalk.cyan('master'))

    return
  }

  // if we arent deploying to production return
  if (env !== 'production') {
    console.log('Skipping doc scraping because you deployed to:', chalk.cyan(env))
    console.log('Only scraping production deploy')
    return
  }

  return getScrapeDocs()
  .then((bool) => {
    if (bool) {
      return scrape()
    }
  })

}

function deployEnvironmentBranch (env, branch) {
  la(is.unemptyString(branch), 'missing branch to deploy', branch)
  la(isValidEnvironment(env), 'invalid deploy environment', env)

  // const cleanup = () => {
  //   console.log('Target environment:', chalk.green(env))
  //   console.log('On branch:', chalk.green(branch), '\n')
  //   if (env === 'staging') {
  //     return env
  //   }

  //   if (env === 'production') {
  //     if (branch !== 'master') {
  //       throw new Error('Cannot deploy master to production. You are not on the \'master\' branch.')
  //     }

  //     return ensureCleanWorkingDirectory()
  //   } else {
  //     throw new Error(`Unknown environment: ${env}`)
  //   }
  // }

  const uploadEnvToS3 = _.partial(uploadToS3, env)
  const maybeCommit = () =>
    commitMessage(env, branch)
    .catch((err) => {
      // ignore commit error - do we really need it?
      console.error('could not make a doc commit')
      console.error(err.message)
    })

  return checkBranchEnvFolder(branch)(env)
  .then(uploadEnvToS3)
  .then(maybeCommit)
  .then(() => scrapeDocs(env, branch))
  .then(() => {
    console.log(chalk.yellow('\n==============================\n'))
    console.log(chalk.bgGreen(chalk.black(' Done Deploying ')))
    console.log('')
  })
}

function doDeploy (env) {
  la(isValidEnvironment(env), 'invalid deploy environment', env)
  debug('getting current branch')
  return getCurrentBranch()
    .then((branch) => {
      console.log('deploying branch %s to %s', branch, env)
      la(is.unemptyString(branch), 'invalid branch name', branch)
      return deployEnvironmentBranch(env, branch)
    })
}

function deploy () {
  console.log()
  console.log(chalk.yellow('Cypress Docs Deploy'))
  console.log(chalk.yellow('==============================\n'))

  warnIfNotCI()

  return getDeployEnvironment()
  .then((env) => {
    return shouldDeploy(env)
    .then((should) => {
      if (!should) {
        console.log('nothing to deploy for environment %s', env)
        return false
      }
      return doDeploy(env)
    })
  })
}

deploy()
  .catch((err) => {
    console.error('🔥  deploy failed')
    console.error(err)
    console.error(err.stack)
    process.exit(-1)
  })
