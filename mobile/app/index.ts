import 'expo-router/entry';
import { AppRegistry } from 'react-native';

import { answerTask } from './src/notify/cards';

AppRegistry.registerHeadlessTask('SikemuxAnswer', () => answerTask);
