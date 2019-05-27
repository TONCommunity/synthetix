'use strict';

const fs = require('fs');
const { gray, yellow, red, cyan } = require('chalk');
const Web3 = require('web3');
const w3utils = require('web3-utils');

const { CONFIG_FILENAME, DEPLOYMENT_FILENAME } = require('../constants');

const {
	toBytes4,
	ensureNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	appendOwnerActionGenerator,
	stringify,
} = require('../util');

module.exports = program =>
	program
		.command('remove-synths')
		.description('Remove a number of synths from the system')
		.option(
			'-d, --deployment-path <value>',
			`Path to a folder that has your input configuration file ${CONFIG_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
		)
		.option('-g, --gas-price <value>', 'Gas price in GWEI', 1)
		.option('-l, --gas-limit <value>', 'Gas limit', 15e4)
		.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'kovan')
		.option(
			'-s, --synths-to-remove <value>',
			'The list of synths to remove',
			(val, memo) => {
				memo.push(val);
				return memo;
			},
			[]
		)
		.action(async ({ network, deploymentPath, gasPrice, gasLimit, synthsToRemove }) => {
			ensureNetwork(network);

			const {
				synths,
				synthsFile,
				deployment,
				config,
				configFile,
				ownerActions,
				ownerActionsFile,
			} = loadAndCheckRequiredSources({
				deploymentPath,
				network,
			});

			if (synthsToRemove.length < 1) {
				console.log(gray('No synths provided. Please use --synths-to-remove option'));
				return;
			}

			// sanity-check the synth list
			for (const synth of synthsToRemove) {
				if (synths.filter(({ name }) => name === synth).length < 1) {
					console.error(red(`Synth ${synth} not found!`));
					process.exitCode = 1;
					return;
				} else if (['XDR', 'sUSD'].indexOf(synth) >= 0) {
					console.error(red(`Synth ${synth} cannot be removed`));
					process.exitCode = 1;
					return;
				}
			}

			const { providerUrl, privateKey, etherscanLinkPrefix } = loadConnections({ network });

			const appendOwnerAction = appendOwnerActionGenerator({
				ownerActions,
				ownerActionsFile,
				etherscanLinkPrefix,
			});

			const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));
			web3.eth.accounts.wallet.add(privateKey);
			const account = web3.eth.accounts.wallet[0].address;
			console.log(gray(`Using account with public key ${account}`));
			console.log(gray(`Using gas of ${gasPrice} GWEI with a max of ${gasLimit}`));

			try {
				await confirmAction(
					cyan(
						`${yellow(
							'WARNING'
						)}: This action will remove the following synths from the Synthetix contract on ${network}:\n- ${synthsToRemove.join(
							'\n- '
						)}`
					) + '\nDo you want to continue? (y/n) '
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}

			const { address: synthetixAddress, source } = deployment.targets['Synthetix'];
			const { abi: synthetixABI } = deployment.sources[source];
			const Synthetix = new web3.eth.Contract(synthetixABI, synthetixAddress);

			const synthetixOwner = await Synthetix.methods.owner().call();

			for (const currencyKey of synthsToRemove) {
				// eslint-disable-next-line standard/computed-property-even-spacing
				const { address: synthAddress, source: synthSource } = deployment.targets[
					`Synth${currencyKey}`
				];
				const { abi: synthABI } = deployment.sources[synthSource];
				const Synth = new web3.eth.Contract(synthABI, synthAddress);

				const currentSynthInSNX = await Synthetix.methods.synths(toBytes4(currencyKey)).call();

				if (synthAddress !== currentSynthInSNX) {
					console.error(
						red(
							`Synth address in Synthetix for ${currencyKey} is different from what's deployed in Synthetix to the local ${DEPLOYMENT_FILENAME} of ${network} \ndeployed: ${yellow(
								currentSynthInSNX
							)}\nlocal:    ${yellow(synthAddress)}`
						)
					);
					process.exitCode = 1;
					return;
				}

				// now check total supply (is required in Synthetix.removeSynth)
				const totalSupply = w3utils.fromWei(await Synth.methods.totalSupply().call());
				if (Number(totalSupply) > 0) {
					console.error(
						red(
							`Cannot remove as Synth${currencyKey}.totalSupply is non-zero: ${yellow(totalSupply)}`
						)
					);
					process.exitCode = 1;
					return;
				}

				if (synthetixOwner === account) {
					console.log(yellow(`Invoking Synthetix.removeSynth(Synth${currencyKey})...`));
					await Synthetix.methods.removeSynth(toBytes4(currencyKey)).send({
						from: account,
						gas: Number(gasLimit),
						gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
					});
					console.log(
						gray(
							`Removed ${currencyKey} from Synthetix. Verify via ${etherscanLinkPrefix}/address/${synthetixAddress}#readContract`
						)
					);
				} else {
					appendOwnerAction({
						key: `Synthetix.removeSynth(Synth${currencyKey})`,
						target: synthetixAddress,
						action: `removeSynth(${currencyKey})`,
					});
				}

				// now update the config.json file
				const contracts = ['Proxy', 'TokenState', 'Synth'].map(name => `${name}${currencyKey}`);
				for (const contract of contracts) {
					delete config[contract];
				}
				fs.writeFileSync(configFile, stringify(config));

				// and update the synths.json file
				const updatedSynthList = synths.filter(({ name }) => name !== currencyKey);
				fs.writeFileSync(synthsFile, stringify(updatedSynthList));
			}
		});