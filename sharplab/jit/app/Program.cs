using System.Runtime.CompilerServices;
class P{ [MethodImpl(MethodImplOptions.NoInlining)] static int Add(int a,int b)=>a+b; static void Main(){System.Console.WriteLine(Add(1,2));}}
