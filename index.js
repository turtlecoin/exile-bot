// Copyright (c) 2018, TurtleCoin Developers
//
// Please see the included LICENSE file for more information.

'use strict'

const Config = require('./config.json')
const Discord = require('discord.js')
const Franc = require('franc')
const ISO6391 = require('iso-639-1')
const Sqlite3 = require('sqlite3')
const Translator = require('google-translate')(Config.translation.apiKey)
const util = require('util')

const Client = new Discord.Client()

const db = new Sqlite3.Database(Config.database, (err) => {
  if (err) {
    log('Could not connect to backend database')
    process.exit(1)
  }
  run([
    'CREATE TABLE IF NOT EXISTS ',
    'exiled_users ',
    '(id TEXT PRIMARY KEY, oldNickname TEXT, reason TEXT)'
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
      if (row.id === id) return resolve({ status: true, oldNickname: row.oldNickname })
      return resolve({ status: false })
    }).catch(() => {
      return resolve({ status: false })
    })
  })
}

function getExileReason (id) {
  return new Promise((resolve, reject) => {
    get('SELECT reason FROM exiled_users WHERE id = ?', [id]).then((row) => {
      return resolve(row.reason)
    }).catch(() => {
      return resolve('')
    })
  })
}

function exile (id, oldNickname, reason) {
  reason = reason || ''
  reason = reason.replace(`${Config.trigger}exile`, '')
  reason = reason.replace(/<@[0-9]*>/, '')
  reason = reason.trim()
  return new Promise((resolve, reject) => {
    run('REPLACE INTO exiled_users (id, oldNickname, reason) VALUES (?,?,?)', [id, oldNickname, reason]).then(() => {
      return resolve(true)
    }).catch(() => {
      return reject(new Error('Could not save exile to database'))
    })
  })
}

function release (id) {
  return new Promise((resolve, reject) => {
    run('DELETE FROM exiled_users WHERE id = ?', [id]).then(() => {
      return resolve()
    }).catch(() => {
      return reject(new Error('Could not release user from database'))
    })
  })
}

function tryChangeNickname (member, newNickname) {
  return new Promise((resolve, reject) => {
    member.setNickname(newNickname).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryChannelSendMessage (channel, message) {
  return new Promise((resolve, reject) => {
    channel.send(message).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryRemoveRole (member, role) {
  return new Promise((resolve, reject) => {
    member.removeRole(role).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryAddRole (member, role) {
  return new Promise((resolve, reject) => {
    member.addRole(role).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryMessageReact (message, reaction) {
  return new Promise((resolve, reject) => {
    message.react(reaction).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryTranslation (message) {
  return new Promise((resolve, reject) => {
    const lang = Franc(message)
    const langName = ISO6391.getName(lang) || lang

    if (lang === 'eng') {
      return resolve({ message: message, original: message, lang: 'English' })
    }

    Translator.translate(message, 'en', (error, translation) => {
      if (error) return resolve({ message: message, original: message, lang: langName })
      translation.detectedSourceLanguage = translation.detectedSourceLanguage.split('-', 1).join('')
      return resolve({ message: translation.translatedText, original: message, lang: ISO6391.getName(translation.detectedSourceLanguage) })
    })
  })
}

function execExile (message, member, channel, role) {
  const oldNickname = member.displayName
  const id = RandomNumber()
  const newNickname = `${Config.inmateNamePrefix} ${id}`

  /* Try to change their nickname */
  tryChangeNickname(member, newNickname).then((success) => {
    if (success) {
      log(`${message.author.username} changed nickname of "${oldNickname}" to "${newNickname}"`)
    }
    /* Add the role to their account */
    return tryAddRole(member, role)
  }).then(() => {
    /* Store the exile in the database */
    return exile(member.id, oldNickname, message.content.toString())
  }).then(() => {
    log(`${message.author.username} assigned role "${role.name}" to "${newNickname}"`)
    const mention = member.toString()

    /* Try to send a message to the channel letting them know they are exiled */
    return tryChannelSendMessage(channel, `${mention} ${Config.exileMessage}`)
  }).then(() => {
    /* React to the initial message */
    return tryMessageReact(message, Config.reaction)
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log(`Error assigning "${role.name}" to "${member.displayName}": ${error}`)
    }
  })
}

function execRelease (message, member, channel, role) {
  /* Check to see if they are already exiled */
  isExiled(member.id).then((result) => {
    /* Try to change their nickname back */
    if (result.status) {
      return tryChangeNickname(member, result.oldNickname)
    }
  }).then(() => {
    /* Remove the role from their account */
    return tryRemoveRole(member, role)
  }).then(() => {
    /* remove the exile from the database */
    return release(member.id)
  }).then(() => {
    /* React to the initial message */
    return tryMessageReact(message, Config.reaction)
  }).then(() => {
    log(`${message.author.username} removed role "${role.name}" from "${member.displayName}"`)
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log(`Error removing "${role.name}" from "${member.displayName}"`)
    }
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

function isEnforcer (id) {
  if (Config.enforcers.indexOf(id) === -1) {
    return false
  }
  return true
}

function log (message) {
  console.log(util.format('%s: %s', (new Date()).toUTCString(), message))
}

Client.on('ready', () => {
  log(`Logged in as ${Client.user.tag}!`)
})

/* This handler is designed to check for market related talk in any language */
Client.on('message', (message) => {
  /* Check to make sure that we're in a monitored server */
  if (Config.serverIds.indexOf(message.guild.id) === -1) return

  const channelName = message.channel.name
  const guildName = message.guild.name

  /* Get the user so we can mention them later */
  const mention = message.author.username
  
  if (mention.toLowerCase() === 'mee6') return

  /* Try to translate the message */
  tryTranslation(message.content).then((messageObj) => {
    const msg = messageObj.message.toLowerCase()

    /* Now loop through our trigger words and see if someone has been naughty */
    var triggered = false
    Config.translation.triggerWords.forEach((triggerWord) => {
      triggerWord = triggerWord.toLowerCase()

      if (msg.indexOf(triggerWord) !== -1) {
        triggered = true
      }
    })

    /* Ut oh, someone has been naughty */
    if (triggered) {
      const msgPayload = {
        embed: {
          title: `Market Talk in ${guildName} #${channelName}?`,
          author: {
            name: mention
          },
          url: `https://discordapp.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
          fields: [
            {
              name: 'Original Message',
              value: messageObj.original
            },
            {
              name: 'Translated',
              value: msg
            }
          ],
          footer: {
            text: `Language: ${messageObj.lang}`
          }
        }
      }
      if (messageObj.lang === 'English') msgPayload.embed.fields.splice(-1, 1)
      log(msg)
      Client.guilds.get(Config.translation.notificationGuild).channels.get(Config.translation.notificationChannel)
      Client.guilds.get(Config.translation.notificationGuild).channels.get(Config.translation.notificationChannel).send(msgPayload).catch((err) => { log(err) })
    }
  })
})

Client.on('message', (message) => {
  /* Check to make sure that we should be monitoring the server
     that we are connected to */
  if (Config.serverIds.indexOf(message.guild.id) === -1) return

  /* Go get our role that we want to use for naughty people */
  const role = message.guild.roles.find(r => r.name === Config.exileRoleName)

  /* Go get the channel where we'll be printing our nice messages to the naughty people */
  const channel = message.guild.channels.find(channel => channel.name === Config.exileChannelName)

  /* If we couldn't get the correct role then we need to bail */
  if (!role) return

  /* Did someone call for an exile? */
  if (message.content.startsWith(`${Config.trigger}exile`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    /* Loop through the mentioned users */
    message.mentions.members.forEach((member) => {
      /* If we don't have access to run this command... */
      if (!isEnforcer(message.author.id)) {
        /* If we tried to exile an enforcer */
        if (isEnforcer(member.id)) {
          log(`${message.author.username} fought the law and the law won!`)
          execExile(message, message.member, channel, role)
          return setTimeout(() => {
            execRelease(message, message.member, channel, role)
            log(`${message.author.username} has been released from the drunk tank`)
          }, Config.drunktankTimer)
        }

        /* We're done here */
        return
      } else if (isEnforcer(member.id)) {
        /* We don't let enforcers exile enforcers */
        return
      }

      execExile(message, member, channel, role)
    })
  /* Or are we going to release the person */
  } else if (message.content.startsWith(`${Config.trigger}release`) || message.content.startsWith(`${Config.trigger}unexile`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    /* If we don't have permission to perform this command, then we'll pretend like nothing happened */
    if (!isEnforcer(message.author.id)) return

    message.mentions.members.forEach((member) => {
      execRelease(message, member, channel, role)
    })
  } else if (message.content.startsWith(`${Config.trigger}crime`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    const mention = message.member.toString()

    /* If they aren't an enforcer, look at themselves */
    if (!isEnforcer(message.author.id)) {
      getExileReason(message.author.id).then((reason) => {
        if (reason.length !== 0) {
          reason = '```' + reason + '```'
          return message.channel.send(`${mention} The message scrawled across your warrant states: ${reason}`).catch(() => {})
        } else {
          return message.channel.send(`${mention} There is no warant out for you`).catch(() => {})
        }
      })
    } else {
      const target = message.mentions.members.first()
      if (!target) return

      getExileReason(target.id).then((reason) => {
        if (reason.length !== 0) {
          return message.channel.send(`The warrant for ${target} states: ${reason}`).catch(() => {})
        }
      })
    }
  } else if (message.content.startsWith(`<@&${Config.exileRoleId}>`)) {
    /* Did someone call @exiled? */
    return message.channel.send(`https://youtu.be/u0I5ZZ6dlto`).catch(() => {})
  }
})

Client.on('guildMemberAdd', (member) => {
  const role = member.guild.roles.find(r => r.name === Config.exileRoleName)
  const channel = member.guild.channels.find(channel => channel.name === Config.exileChannelName)

  if (!role) return

  const oldNickname = member.displayName
  const id = RandomNumber()
  const newNickname = `${Config.inmateNamePrefix} ${id}`

  /* check to see if the joiner is in exiled */
  isExiled(member.id).then((result) => {
    if (!result.status) {
      throw new BreakSignal()
    }

    log(`${oldNickname} rejoined the server and they should be in exile`)

    /* Try to change their nickname */
    return tryChangeNickname(member, newNickname)
  }).then(() => {
    log(`Autojoin changed nickname of "${oldNickname}" to "${newNickname}"`)

    /* Add the role to their account */
    return tryAddRole(member, role)
  }).then(() => {
    log(`Autojoin assigned role "${role.name}" to "${newNickname}"`)
    const mention = member.toString()

    /* Try to send a message to the channel letting them know they are exiled */
    return tryChannelSendMessage(channel, `${mention} ${Config.exileEvadeMessage}`)
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

Client.on('error', (error) => {
  log('The connection to discord encountered an error: ' + error.toString())
  process.exit(1)
})
