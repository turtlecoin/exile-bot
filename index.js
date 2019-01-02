// Copyright (c) 2018, TurtleCoin Developers
//
// Please see the included LICENSE file for more information.

'use strict'

const Config = require('./config.json')
const util = require('util')
const Sqlite3 = require('sqlite3')
const Discord = require('discord.js')
const Client = new Discord.Client()
const db = new Sqlite3.Database(Config.database, (err) => {
  if (err) {
    log('Could not connect to backend database')
    process.exit(1)
  }
  run([
    'CREATE TABLE IF NOT EXISTS ',
    'exiled_users ',
    '(id TEXT PRIMARY KEY, oldNickname TEXT)'
  ].join('')).then(() => {
    log('Connected to backend database')
  }).catch(() => {
    log('Could not create "exiled_users" table')
    process.exit(1)
  })
})

function BreakSignal () {}

function run (query, args) {
  return new Promise((resolve, reject) => {
    db.run(query, args, (err) => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

function get (query, args) {
  return new Promise((resolve, reject) => {
    db.get(query, args, (err, row) => {
      if (err || !row) return reject(err)
      return resolve(row)
    })
  })
}

function isExiled (id) {
  return new Promise((resolve, reject) => {
    get('SELECT * FROM exiled_users WHERE id = ?', [id]).then((row) => {
      if (row.id === id) return resolve(true)
      return resolve(false)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function exile (id, oldNickname) {
  return new Promise((resolve, reject) => {
    run('INSERT INTO exiled_users (id, oldNickname) VALUES (?,?)', [id, oldNickname]).then(() => {
      return resolve(true)
    }).catch(() => {
      return reject(new Error('Could not save exile to database'))
    })
  })
}

function release (id) {
  return new Promise((resolve, reject) => {
    var oldNickname
    get('SELECT oldNickname FROM exiled_users WHERE id = ?', [id]).then((row) => {
      oldNickname = row.oldNickname
      return run('DELETE FROM exiled_users WHERE id = ?', [id])
    }).then(() => {
      return resolve(oldNickname)
    }).catch(() => {
      return reject(new Error('Could not release user from database'))
    })
  })
}

function RandomNumber () {
  const rn = require('random-number')
  const gen = rn.generator({
    min: 10000,
    max: 99999,
    integer: true
  })
  return gen()
}

function log (message) {
  console.log(util.format('%s: %s', (new Date()).toUTCString(), message))
}

Client.on('ready', () => {
  log(`Logged in as ${Client.user.tag}!`)
})

Client.on('message', (message) => {
  /* Check to make sure that we should be monitoring the server
     that we are connected to */
  if (Config.serverIds.indexOf(message.guild.id) === -1) return

  /* Check to see if the message came from one of the hard
     coded users in our config file, if not, we're done */
  if (Config.enforcers.indexOf(message.author.id) === -1) return

  /* Go get our role that we want to use for members */
  const role = message.guild.roles.find(r => r.name === Config.exileRoleName)
  const channel = message.guild.channels.find(channel => channel.name === Config.exileChannelName)

  if (!role || !channel) return

  if (message.content.startsWith(`${Config.trigger}exile`)) {
    message.mentions.members.forEach((member) => {
      if (Config.enforcers.indexOf(member.id) !== -1) return

      const oldNickname = member.displayName
      const id = RandomNumber()
      const newNickname = `${Config.inmateNamePrefix} ${id}`

      isExiled(member.id).then((status) => {
        if (status) {
          log(`${oldNickname} is already exiled`)
          throw new BreakSignal()
        }
        return exile(member.id, oldNickname)
      }).then(() => {
        return member.setNickname(newNickname)
      }).then(() => {
        log(`${message.author.username} changed nickname of "${oldNickname}" to "${newNickname}"`)
        return member.addRole(role)
      }).then(() => {
        log(`${message.author.username} assigned role "${role.name}" to "${newNickname}"`)
        const mention = member.toString()
        return channel.send(`${mention} ${Config.exileMessage}`)
      }).catch((error) => {
        if (!(error instanceof BreakSignal)) {
          log(`Error assigning "${role.name}" to "${member.displayName}"`)
        }
      })
    })
  } else if (message.content.startsWith(`${Config.trigger}release`)) {
    message.mentions.members.forEach((member) => {
      isExiled(member.id).then((status) => {
        if (!status) {
          log(`${member.displayName} is not currently exiled`)
          throw new BreakSignal()
        }
        return release(member.id)
      }).then((oldNickname) => {
        return member.setNickname(oldNickname)
      }).then(() => {
        return member.removeRole(role)
      }).then(() => {
        log(`${message.author.username} removed role "${role.name}" from "${member.displayName}"`)
      }).catch((error) => {
        if (!(error instanceof BreakSignal)) {
          log(`Error removing "${role.name}" from "${member.displayName}"`)
        }
      })
    })
  }
})

Client.on('guildMemberAdd', (member) => {
  const role = member.guild.roles.find(r => r.name === Config.exileRoleName)
  const channel = member.guild.channels.find(channel => channel.name === Config.exileChannelName)

  if (!role || !channel) return

  const oldNickname = member.displayName
  const id = RandomNumber()
  const newNickname = `${Config.inmateNamePrefix} ${id}`

  isExiled(member.id).then((status) => {
    if (!status) {
      throw new BreakSignal()
    }

    return member.setNickname(newNickname)
  }).then(() => {
    log(`Autojoin changed nickname of "${oldNickname}" to "${newNickname}"`)
    return member.addRole(role)
  }).then(() => {
    log(`Autojoin assigned role "${role.name}" to "${newNickname}"`)
    const mention = member.toString()
    return channel.send(`${mention} ${Config.exileEvadeMessage}`)
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log(`Error handling user join`)
      console.log(error)
    }
  })
})

Client.login(Config.token).catch((err) => {
  log('There was an error logging into Discord... please check your token and try again')
  log(err.toString())
})
