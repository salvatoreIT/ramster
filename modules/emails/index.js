'use strict'

let sendgrid = require('sendgrid'),
	pug = require('pug'),
	path = require('path'),
	co = require('co')

let emails = class Emails {
	constructor(cfg) {
		this.cfg = cfg
		this.sendgrid = sendgrid(this.cfg.emails.sendgridApiKey)
		this.sender = this.cfg.emails.emailSender
	}

	sendEmail({to, subject, templateName, fields}) {
		let instance = this
		return co(function*(){
			let template = (pug.compileFile(path.join(instance.cfg.emails.templatesPath, `${templateName}.pug`), {}))(fields || {}),
				receivers = [],
				bccs = []

			if (to instanceof Array) {
				to.forEach((el, i) => {
					receivers.push({email: el})
				})
			} else {
				receivers.push({email: to})
			}

			let bccMails = instance.cfg.emails.bcc
			if (bccMails instanceof Array) {
				bccMails.forEach((el, i) => {
					bccs.push({email: el})
				})
			} else if (typeof bccMails === 'string'){
				bccs.push({email: bccMails})
			}

			let personalizations = {
				to: receivers,
				subject: subject
			}
			if (bccs.length > 0) {
				personalizations.bcc = bccs
			}

			return yield instance.sendgrid.API(instance.sendgrid.emptyRequest({
				method: 'POST',
			  	path: '/v3/mail/send',
				body: {
					personalizations: [personalizations],
					from: {email: instance.sender,},
					content: [{
						type: 'text/html',
						value: template,
					}]
				}
			}))
		})
	}
}
module.exports = emails
