const datefns = require('date-fns')
const https = require('https')
const axios = require('axios')
const slugify = require('slugify')

const Backup = require('./src/Backup')
const Storage = require('./src/Storage')
const Manager = require('./src/Manager')
const helpers = require('./src/helpers')
const argv = require('minimist')(process.argv.slice(2))
const fs = require('fs')

// get config path
try {
  const rawdata = fs.readFileSync(argv._[0])

  const config = JSON.parse(rawdata)
  const manager = new Manager(config)

;(async function () {
  // iterate over all projects to backup
    helpers.asyncForEach(config.projects, async (project) => {
      const slug = slugify(project.slug, {
        replacement: '_',
        remove: /[*+~.()'"!:@-]/g,
        lower: true,
        strict: true
      })

      helpers.info('processing...', slug)

      // get all backups from S3
      const s3 = new Storage(config.awsAccessKeyId, config.awsSecretAccessKey, config.awsBucket)
      let filesList = await s3.listAllFilesForProject(slug)

      // check for backup
      const toProcess = manager.checkForBackup(project, filesList)

      if (toProcess.length > 0) {
        helpers.info(`prepare ${toProcess}`, slug)

        const formatedDate = datefns.format(new Date(), 'yyyyMMdd_HHmmss')
        const filename = slug + '-' + formatedDate

        // backup, upload to S3 and clean old backups
        try {
          const backup = await Backup.exec(project.path, filename)
          helpers.info('run pliz backup command', slug)

          // sync upload to spare network
          await helpers.asyncForEach(toProcess, async (frequency) => {
            const s3Filename = `${slug}-${frequency}-${formatedDate}.tar.gz`
            helpers.info(`upload ${s3Filename} to s3`, slug)
            await s3.uploadFile(backup, slug, s3Filename)
          })

          // clean old backups
          filesList = await s3.listAllFilesForProject(slug)
          const toDelete = manager.checkForBackupToDelete(project, filesList)

          // sync delete
          await helpers.asyncForEach(toDelete, async (key) => {
            helpers.info(`delete ${key} from s3`, slug)
            await s3.deleteFile(key)
          })

          // delete local backup
          helpers.info(`delete local file ${backup}`, slug)
          fs.unlinkSync(backup)

          // ping URL
          https.get(project.pingUrl)
        } catch (error) {
          console.error(error)

          // specific to provider(s)
          // healthchecks.io
          if (new URL(project.pingUrl).hostname === 'hc-ping.com') {
            axios({
              method: 'post',
              url: project.pingUrl + '/fail',
              data: error.message
            })
          }
        }
      } else {
        https.get(project.pingUrl)
        helpers.info('no backup to perform', slug)
      }
    })
  })()
} catch (err) {
  console.error('Unable to open config file')
  process.exit(1)
}
