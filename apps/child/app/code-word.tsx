import { Btn, Card, Field, Notice, Pop, Screen, T, TopBar } from '@/components/sahaj/ui';
import { updateDemo, useDemo } from '@/lib/demo';
import * as React from 'react';
export default function CodeWord() {
  const demo = useDemo();
  const [word, setWord] = React.useState(demo.codeWord);
  const [message, setMessage] = React.useState('');
  React.useEffect(() => {
    setWord(demo.codeWord);
    setMessage('');
  }, [demo.revision]);
  return (
    <Screen>
      <TopBar title="Family code word" />
      <Pop>
        <T v="title">A word only you know</T>
        <T v="body" className="mt-2">
          If a caller claims to be family, Maa can ask for this word.
        </T>
        <Card tone="brand" className="mt-6">
          <T v="label">Your current word</T>
          <T v="display" className="mt-3 text-brand-deep">
            {demo.codeWord}
          </T>
          <T v="small" className="mt-3">
            Share it with family in a conversation you trust.
          </T>
        </Card>
        <Field label="New code word" value={word} onChangeText={setWord} maxLength={24} />
        <Btn
          label="Save word"
          className="mt-5"
          onPress={() => {
            if (word.trim().length < 3) {
              setMessage('Choose a word with at least 3 letters.');
              return;
            }
            updateDemo({ codeWord: word.trim() });
            setMessage('Saved in this demo · agree the new word with Maa.');
          }}
        />
      </Pop>
      {message ? <Notice>{message}</Notice> : null}
    </Screen>
  );
}
